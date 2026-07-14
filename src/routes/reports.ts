import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { requirePerm } from '../guard';

type AppContext = { Bindings: Env; Variables: AppVariables };

const MONTH_LABELS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const reports = new Hono<AppContext>();

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return ym;
  return `${MONTH_LABELS[m - 1]} ${y}`;
}

/** Istanbul (+03) calendar month → UTC ISO bounds for created_at filters */
export function monthBounds(yearMonth: string): { from: string; to: string } | null {
  const match = yearMonth.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const fromLocal = `${match[1]}-${match[2]}-01T00:00:00+03:00`;
  const toLocal = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+03:00`;
  const fromMs = Date.parse(fromLocal);
  const toMs = Date.parse(toLocal);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) return null;
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

async function monthTxStats(env: Env, from: string, to: string) {
  return env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as income_total,
       COUNT(*) as transaction_count,
       SUM(CASE WHEN type = 'walk_in' THEN 1 ELSE 0 END) as walk_in_count,
       SUM(CASE WHEN type = 'agency' AND COALESCE(amount, 0) = 0 THEN 1 ELSE 0 END) as agency_count,
       SUM(CASE WHEN type = 'agency' AND COALESCE(amount, 0) > 0 THEN 1 ELSE 0 END) as agency_pay_at_door_count
     FROM transactions
     WHERE created_at >= ? AND created_at < ?`
  ).bind(from, to).first<{
    income_total: number;
    transaction_count: number;
    walk_in_count: number;
    agency_count: number;
    agency_pay_at_door_count: number;
  }>();
}

async function monthExpStats(env: Env, from: string, to: string) {
  return env.DB.prepare(
    `SELECT
       COALESCE(SUM(amount), 0) as expense_total,
       COUNT(*) as expense_count
     FROM expenses
     WHERE created_at >= ? AND created_at < ?`
  ).bind(from, to).first<{ expense_total: number; expense_count: number }>();
}

const REPORTS_MIN_YEAR = 2025;

function istanbulYear(date = new Date()): number {
  const y = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
  }).format(date));
  return Number.isFinite(y) ? y : date.getUTCFullYear();
}

function reportYearOptions(now = new Date()): number[] {
  const maxYear = istanbulYear(now);
  const years: number[] = [];
  for (let y = maxYear; y >= REPORTS_MIN_YEAR; y -= 1) years.push(y);
  return years;
}

function clampReportYear(raw: string | undefined): number {
  const maxYear = istanbulYear();
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed)) return maxYear;
  return Math.min(maxYear, Math.max(REPORTS_MIN_YEAR, parsed));
}

reports.get('/months', async (c) => {
  const denied = requirePerm(c, 'shift.view.all');
  if (denied) return denied;

  const years = reportYearOptions();
  const year = clampReportYear(c.req.query('year') || undefined);
  const yearPrefix = `${year}-`;

  const [txMonths, expMonths] = await Promise.all([
    c.env.DB.prepare(
      `SELECT DISTINCT substr(datetime(created_at, '+3 hours'), 1, 7) as ym
       FROM transactions
       WHERE created_at IS NOT NULL
         AND substr(datetime(created_at, '+3 hours'), 1, 4) = ?
       ORDER BY ym DESC`
    ).bind(String(year)).all<{ ym: string }>(),
    c.env.DB.prepare(
      `SELECT DISTINCT substr(datetime(created_at, '+3 hours'), 1, 7) as ym
       FROM expenses
       WHERE created_at IS NOT NULL
         AND substr(datetime(created_at, '+3 hours'), 1, 4) = ?
       ORDER BY ym DESC`
    ).bind(String(year)).all<{ ym: string }>(),
  ]);

  const ymSet = new Set<string>();
  for (const r of txMonths.results || []) if (r.ym?.startsWith(yearPrefix)) ymSet.add(r.ym);
  for (const r of expMonths.results || []) if (r.ym?.startsWith(yearPrefix)) ymSet.add(r.ym);
  const months = [...ymSet].sort((a, b) => b.localeCompare(a));

  const items = await Promise.all(months.map(async (ym) => {
    const bounds = monthBounds(ym);
    if (!bounds) return null;
    const [tx, exp] = await Promise.all([
      monthTxStats(c.env, bounds.from, bounds.to),
      monthExpStats(c.env, bounds.from, bounds.to),
    ]);
    const income_total = Number(tx?.income_total) || 0;
    const expense_total = Number(exp?.expense_total) || 0;
    return {
      year_month: ym,
      label: monthLabel(ym),
      income_total,
      expense_total,
      net: income_total - expense_total,
      transaction_count: Number(tx?.transaction_count) || 0,
      expense_count: Number(exp?.expense_count) || 0,
      walk_in_count: Number(tx?.walk_in_count) || 0,
      agency_count: Number(tx?.agency_count) || 0,
      agency_pay_at_door_count: Number(tx?.agency_pay_at_door_count) || 0,
    };
  }));

  return c.json({
    year,
    years,
    months: items.filter(Boolean),
  });
});

reports.get('/months/:ym', async (c) => {
  const denied = requirePerm(c, 'shift.view.all');
  if (denied) return denied;

  const ym = c.req.param('ym');
  const bounds = monthBounds(ym);
  if (!bounds) return c.json({ error: 'Invalid month' }, 400);

  const [txStats, expStats, incomeByMethod, expenseByCategory, transactions, expenses] = await Promise.all([
    monthTxStats(c.env, bounds.from, bounds.to),
    monthExpStats(c.env, bounds.from, bounds.to),
    c.env.DB.prepare(
      `SELECT payment_method, COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE created_at >= ? AND created_at < ? AND amount > 0
       GROUP BY payment_method
       ORDER BY total DESC`
    ).bind(bounds.from, bounds.to).all(),
    c.env.DB.prepare(
      `SELECT category, COUNT(*) as count, COALESCE(SUM(amount), 0) as total
       FROM expenses
       WHERE created_at >= ? AND created_at < ?
       GROUP BY category
       ORDER BY total DESC`
    ).bind(bounds.from, bounds.to).all(),
    c.env.DB.prepare(
      `SELECT t.*, u.display_name as created_by_name, u.username as created_by_username
       FROM transactions t
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.created_at >= ? AND t.created_at < ?
       ORDER BY t.created_at DESC`
    ).bind(bounds.from, bounds.to).all(),
    c.env.DB.prepare(
      `SELECT e.*, u.display_name as created_by_name, u.username as created_by_username
       FROM expenses e
       LEFT JOIN users u ON e.created_by = u.id
       WHERE e.created_at >= ? AND e.created_at < ?
       ORDER BY e.created_at DESC`
    ).bind(bounds.from, bounds.to).all(),
  ]);

  const income_total = Number(txStats?.income_total) || 0;
  const expense_total = Number(expStats?.expense_total) || 0;

  return c.json({
    year_month: ym,
    label: monthLabel(ym),
    from: bounds.from,
    to: bounds.to,
    stats: {
      income_total,
      expense_total,
      net: income_total - expense_total,
      transaction_count: Number(txStats?.transaction_count) || 0,
      expense_count: Number(expStats?.expense_count) || 0,
      walk_in_count: Number(txStats?.walk_in_count) || 0,
      agency_count: Number(txStats?.agency_count) || 0,
      agency_pay_at_door_count: Number(txStats?.agency_pay_at_door_count) || 0,
      income_by_method: incomeByMethod.results || [],
      expense_by_category: expenseByCategory.results || [],
    },
    transactions: transactions.results || [],
    expenses: expenses.results || [],
  });
});

export default reports;
