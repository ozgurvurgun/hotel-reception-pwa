import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, AppVariables } from '../types';
import { requirePerm } from '../guard';

type AppContext = { Bindings: Env; Variables: AppVariables };

const search = new Hono<AppContext>();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

search.use('/*', async (c, next) => {
  const denied = requirePerm(c, 'search.use');
  if (denied) return denied;
  await next();
});

function parsePaging(c: Context<AppContext>) {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || String(DEFAULT_LIMIT), 10), 1), MAX_LIMIT);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);
  const from = c.req.query('from') || undefined;
  const to = c.req.query('to') || undefined;
  return { limit, offset, from, to };
}

function appendDateFilter(
  query: string,
  params: unknown[],
  from?: string,
  to?: string,
  column = 't.created_at',
) {
  let sql = query;
  if (from) {
    sql += ` AND ${column} >= ?`;
    params.push(from);
  }
  if (to) {
    sql += ` AND ${column} < ?`;
    params.push(to);
  }
  return sql;
}

search.get('/guests', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q || q.length < 2) return c.json({ error: 'Enter at least 2 characters' }, 400);

  const { limit, offset, from, to } = parsePaging(c);
  const pattern = `%${q}%`;
  const baseWhere = `(t.guest_name LIKE ? OR t.guest_surname LIKE ?
    OR (t.guest_name || ' ' || COALESCE(t.guest_surname, '')) LIKE ?)`;
  const baseParams: unknown[] = [pattern, pattern, pattern];

  let countQuery = `SELECT COUNT(*) as total FROM transactions t WHERE ${baseWhere}`;
  const countParams = [...baseParams];
  countQuery = appendDateFilter(countQuery, countParams, from, to);

  let resultsQuery = `SELECT t.*, s.started_at as shift_date, u.display_name as created_by_name
    FROM transactions t
    JOIN shifts s ON t.shift_id = s.id
    JOIN users u ON t.created_by = u.id
    WHERE ${baseWhere}`;
  const resultsParams = [...baseParams];
  resultsQuery = appendDateFilter(resultsQuery, resultsParams, from, to);
  resultsQuery += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  resultsParams.push(limit + 1, offset);

  const [countRow, results, summary] = await Promise.all([
    c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>(),
    c.env.DB.prepare(resultsQuery).bind(...resultsParams).all(),
    (() => {
      let summaryQuery = `SELECT
          COUNT(*) as total_visits,
          COALESCE(SUM(amount), 0) as total_paid,
          COUNT(DISTINCT NULLIF(room_number, '')) as room_count,
          GROUP_CONCAT(DISTINCT NULLIF(room_number, '')) as rooms
        FROM transactions t
        WHERE ${baseWhere}`;
      const summaryParams = [...baseParams];
      summaryQuery = appendDateFilter(summaryQuery, summaryParams, from, to);
      return c.env.DB.prepare(summaryQuery).bind(...summaryParams).first<{
        total_visits: number; total_paid: number; room_count: number; rooms: string;
      }>();
    })(),
  ]);

  const rows = results.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    results: page,
    summary,
    pagination: {
      limit,
      offset,
      total: countRow?.total || 0,
      hasMore,
    },
  });
});

search.get('/rooms', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q) return c.json({ error: 'Enter a room number' }, 400);

  const { limit, offset, from, to } = parsePaging(c);
  const pattern = `%${q}%`;

  let countQuery = 'SELECT COUNT(*) as total FROM transactions t WHERE t.room_number LIKE ?';
  const countParams: unknown[] = [pattern];
  countQuery = appendDateFilter(countQuery, countParams, from, to);

  let resultsQuery = `SELECT t.*, s.started_at as shift_date, u.display_name as created_by_name
    FROM transactions t
    JOIN shifts s ON t.shift_id = s.id
    JOIN users u ON t.created_by = u.id
    WHERE t.room_number LIKE ?`;
  const resultsParams: unknown[] = [pattern];
  resultsQuery = appendDateFilter(resultsQuery, resultsParams, from, to);
  resultsQuery += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  resultsParams.push(limit + 1, offset);

  const [countRow, results] = await Promise.all([
    c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>(),
    c.env.DB.prepare(resultsQuery).bind(...resultsParams).all(),
  ]);

  const rows = results.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    results: page,
    pagination: {
      limit,
      offset,
      total: countRow?.total || 0,
      hasMore,
    },
  });
});

search.get('/agencies', async (c) => {
  const q = c.req.query('q')?.trim();
  const { limit, offset, from, to } = parsePaging(c);

  let countQuery = `SELECT COUNT(*) as total FROM transactions t WHERE t.type = 'agency'`;
  const countParams: unknown[] = [];

  let resultsQuery = `SELECT t.*, s.started_at as shift_date, u.display_name as created_by_name
    FROM transactions t
    JOIN shifts s ON t.shift_id = s.id
    JOIN users u ON t.created_by = u.id
    WHERE t.type = 'agency'`;
  const resultsParams: unknown[] = [];

  if (q) {
    countQuery += ' AND t.agency_name LIKE ?';
    resultsQuery += ' AND t.agency_name LIKE ?';
    countParams.push(`%${q}%`);
    resultsParams.push(`%${q}%`);
  }

  countQuery = appendDateFilter(countQuery, countParams, from, to);
  resultsQuery = appendDateFilter(resultsQuery, resultsParams, from, to);
  resultsQuery += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  resultsParams.push(limit + 1, offset);

  const [countRow, results] = await Promise.all([
    c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>(),
    c.env.DB.prepare(resultsQuery).bind(...resultsParams).all(),
  ]);

  const rows = results.results;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    results: page,
    pagination: {
      limit,
      offset,
      total: countRow?.total || 0,
      hasMore,
    },
  });
});

search.get('/global', async (c) => {
  const q = c.req.query('q')?.trim();
  if (!q || q.length < 2) return c.json({ error: 'Enter at least 2 characters' }, 400);

  const { limit, offset, from, to } = parsePaging(c);
  const pattern = `%${q}%`;

  const txWhere = `t.room_number LIKE ? OR t.guest_name LIKE ? OR t.guest_surname LIKE ?
    OR t.agency_name LIKE ? OR t.description LIKE ? OR t.notes LIKE ?`;
  const txParams: unknown[] = [pattern, pattern, pattern, pattern, pattern, pattern];

  let txCountQuery = `SELECT COUNT(*) as total FROM transactions t WHERE ${txWhere}`;
  const txCountParams = [...txParams];
  txCountQuery = appendDateFilter(txCountQuery, txCountParams, from, to, 't.created_at');

  let txQuery = `SELECT 'transaction' as record_type, t.id, t.room_number, t.guest_name, t.guest_surname,
      t.amount, t.payment_method, t.agency_name, t.type, t.description, t.notes, t.created_at,
      u.display_name as created_by_name
    FROM transactions t
    JOIN users u ON t.created_by = u.id
    WHERE ${txWhere}`;
  const txResultsParams = [...txParams];
  txQuery = appendDateFilter(txQuery, txResultsParams, from, to, 't.created_at');
  txQuery += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  txResultsParams.push(limit + 1, offset);

  const expWhere = `e.description LIKE ? OR e.vendor LIKE ? OR e.notes LIKE ? OR e.category LIKE ?`;
  const expParams: unknown[] = [pattern, pattern, pattern, pattern];

  let expCountQuery = `SELECT COUNT(*) as total FROM expenses e WHERE ${expWhere}`;
  const expCountParams = [...expParams];
  expCountQuery = appendDateFilter(expCountQuery, expCountParams, from, to, 'e.created_at');

  let expQuery = `SELECT 'expense' as record_type, e.id, e.category, e.description, e.amount,
      e.payment_method, e.vendor, e.notes, e.created_at, u.display_name as created_by_name
    FROM expenses e
    JOIN users u ON e.created_by = u.id
    WHERE ${expWhere}`;
  const expResultsParams = [...expParams];
  expQuery = appendDateFilter(expQuery, expResultsParams, from, to, 'e.created_at');
  expQuery += ' ORDER BY e.created_at DESC LIMIT ? OFFSET ?';
  expResultsParams.push(limit + 1, offset);

  const [txCount, txResults, expCount, expResults] = await Promise.all([
    c.env.DB.prepare(txCountQuery).bind(...txCountParams).first<{ total: number }>(),
    c.env.DB.prepare(txQuery).bind(...txResultsParams).all(),
    c.env.DB.prepare(expCountQuery).bind(...expCountParams).first<{ total: number }>(),
    c.env.DB.prepare(expQuery).bind(...expResultsParams).all(),
  ]);

  const txRows = txResults.results;
  const txHasMore = txRows.length > limit;
  const txPage = txHasMore ? txRows.slice(0, limit) : txRows;

  const expRows = expResults.results;
  const expHasMore = expRows.length > limit;
  const expPage = expHasMore ? expRows.slice(0, limit) : expRows;

  return c.json({
    transactions: txPage,
    expenses: expPage,
    pagination: {
      limit,
      offset,
      transactionsTotal: txCount?.total || 0,
      expensesTotal: expCount?.total || 0,
      transactionsHasMore: txHasMore,
      expensesHasMore: expHasMore,
      hasMore: txHasMore || expHasMore,
    },
  });
});

export default search;
