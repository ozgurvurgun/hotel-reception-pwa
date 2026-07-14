import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { generateId, now, getClientInfo } from '../auth';
import { logAction } from '../audit';
import {
  sendShiftOpenedNotification,
  sendShiftSummaryNotifications,
  schedulePush,
} from '../push';
import { requirePerm } from '../guard';
import { canViewShift, hasPermission } from '../permissions';
import { scheduleLiveBroadcast } from '../live';

type AppContext = { Bindings: Env; Variables: AppVariables };

const shifts = new Hono<AppContext>();

shifts.get('/active', async (c) => {
  const denied = requirePerm(c, ['shift.open', 'shift.close', 'income.create', 'expense.create', 'guest_entry.create']);
  if (denied) return denied;

  // Shared desk shift: any open shift is visible to all staff
  const shift = await c.env.DB.prepare(
    `SELECT s.*, u.display_name as user_name
     FROM shifts s
     JOIN users u ON s.user_id = u.id
     WHERE s.status = 'open'
     ORDER BY s.started_at DESC
     LIMIT 1`
  ).first();

  if (!shift) return c.json({ shift: null });

  const stats = await getShiftStats(c.env, shift.id as string);
  return c.json({ shift, stats, user_name: shift.user_name });
});

shifts.get('/:id', async (c) => {
  const user = c.get('user');
  const permissions = c.get('permissions');
  const shiftId = c.req.param('id');

  const shift = await c.env.DB.prepare('SELECT * FROM shifts WHERE id = ?')
    .bind(shiftId).first<{ user_id: string; status: string }>();
  if (!shift) return c.json({ error: 'Shift not found' }, 404);

  // Open desk shift is shared; closed history still needs own or view.all
  const deskPerms = ['shift.open', 'shift.close', 'income.create', 'expense.create', 'guest_entry.create'] as const;
  const canSeeOpen = shift.status === 'open' && hasPermission(user.role, permissions, [...deskPerms]);
  if (!canSeeOpen && !canViewShift(user.role, permissions, shift.user_id, user.sub)) {
    return c.json({ error: 'You do not have permission' }, 403);
  }

  const [stats, transactions, expenses, userInfo] = await Promise.all([
    getShiftStats(c.env, shiftId),
    c.env.DB.prepare(
      `SELECT t.*, u.display_name as created_by_name, u.username as created_by_username
       FROM transactions t
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.shift_id = ?
       ORDER BY t.created_at DESC`
    ).bind(shiftId).all(),
    c.env.DB.prepare(
      `SELECT e.*, u.display_name as created_by_name, u.username as created_by_username
       FROM expenses e
       LEFT JOIN users u ON e.created_by = u.id
       WHERE e.shift_id = ?
       ORDER BY e.created_at DESC`
    ).bind(shiftId).all(),
    c.env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(shift.user_id).first<{ display_name: string }>(),
  ]);

  return c.json({
    shift, stats,
    transactions: transactions.results,
    expenses: expenses.results,
    user_name: userInfo?.display_name,
  });
});

shifts.get('/', async (c) => {
  const denied = requirePerm(c, ['shift.open', 'shift.close', 'shift.view.all']);
  if (denied) return denied;

  const user = c.get('user');
  const permissions = c.get('permissions');
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10), 1), 50);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);
  const from = c.req.query('from') || undefined;
  const to = c.req.query('to') || undefined;

  let countQuery = `SELECT COUNT(*) as total FROM shifts s JOIN users u ON s.user_id = u.id`;
  let query = `SELECT s.*, u.display_name as user_name FROM shifts s
    JOIN users u ON s.user_id = u.id`;
  const params: unknown[] = [];
  const countParams: unknown[] = [];
  const where: string[] = [];

  if (!permissions.includes('shift.view.all') && user.role !== 'root') {
    where.push('s.user_id = ?');
    params.push(user.sub);
    countParams.push(user.sub);
  }

  if (from) {
    where.push('s.started_at >= ?');
    params.push(from);
    countParams.push(from);
  }
  if (to) {
    where.push('s.started_at < ?');
    params.push(to);
    countParams.push(to);
  }

  if (where.length) {
    const clause = ` WHERE ${where.join(' AND ')}`;
    countQuery += clause;
    query += clause;
  }

  query += ' ORDER BY s.started_at DESC LIMIT ? OFFSET ?';
  params.push(limit + 1, offset);

  const [countRow, results] = await Promise.all([
    c.env.DB.prepare(countQuery).bind(...countParams).first<{ total: number }>(),
    c.env.DB.prepare(query).bind(...params).all(),
  ]);

  const rows = results.results;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    items,
    pagination: {
      limit,
      offset,
      total: countRow?.total || 0,
      hasMore,
    },
  });
});

shifts.post('/open', async (c) => {
  const denied = requirePerm(c, 'shift.open');
  if (denied) return denied;

  const user = c.get('user');
  const { opening_cash } = await c.req.json<{ opening_cash?: number }>();
  const client = getClientInfo(c.req.raw);

  const existing = await c.env.DB.prepare(
    `SELECT id FROM shifts WHERE status = 'open' LIMIT 1`
  ).first();

  if (existing) {
    return c.json({ error: 'A shift is already open. Close it first.' }, 409);
  }

  const id = generateId();
  const startedAt = now();

  await Promise.all([
    c.env.DB.prepare(
      `INSERT INTO shifts (id, user_id, started_at, status, opening_cash)
       VALUES (?, ?, ?, 'open', ?)`
    ).bind(id, user.sub, startedAt, opening_cash || 0).run(),
    logAction(c.env, {
      userId: user.sub, username: user.username, action: 'SHIFT_OPENED',
      entityType: 'shift', entityId: id,
      details: { opening_cash: opening_cash || 0 },
      ip: client.ip, userAgent: client.userAgent,
    }),
  ]);

  schedulePush(
    c.executionCtx,
    sendShiftOpenedNotification(c.env, {
      shiftId: id,
      userName: user.display_name || user.username,
      startedAt,
    })
  );

  scheduleLiveBroadcast(c.executionCtx, c.env, {
    type: 'shift',
    action: 'opened',
    by: user.display_name || user.username,
  });
  scheduleLiveBroadcast(c.executionCtx, c.env, {
    type: 'shifts',
    action: 'opened',
    by: user.display_name || user.username,
  });

  return c.json({ id, started_at: startedAt, status: 'open' }, 201);
});

shifts.post('/:id/close', async (c) => {
  const denied = requirePerm(c, 'shift.close');
  if (denied) return denied;

  const user = c.get('user');
  const shiftId = c.req.param('id');
  const { closing_cash, closing_notes } = await c.req.json<{
    closing_cash?: number; closing_notes?: string;
  }>();
  const client = getClientInfo(c.req.raw);

  const shift = await c.env.DB.prepare('SELECT * FROM shifts WHERE id = ? AND status = ?')
    .bind(shiftId, 'open').first<{ user_id: string }>();

  if (!shift) return c.json({ error: 'No open shift found' }, 404);

  // Opener closes; only root can force-close another user's shift
  const isOpener = shift.user_id === user.sub;
  if (!isOpener && user.role !== 'root') {
    return c.json({ error: 'Only the person who opened the shift can close it' }, 403);
  }

  const endedAt = now();
  const [, , stats] = await Promise.all([
    c.env.DB.prepare(
      `UPDATE shifts SET status = 'closed', ended_at = ?, closing_cash = ?, closing_notes = ? WHERE id = ?`
    ).bind(endedAt, closing_cash ?? null, closing_notes || null, shiftId).run(),
    logAction(c.env, {
      userId: user.sub, username: user.username, action: 'SHIFT_CLOSED',
      entityType: 'shift', entityId: shiftId,
      details: { closing_cash, closing_notes },
      ip: client.ip, userAgent: client.userAgent,
    }),
    getShiftStats(c.env, shiftId),
  ]);

  schedulePush(c.executionCtx, sendShiftSummaryNotifications(c.env, shiftId));

  scheduleLiveBroadcast(c.executionCtx, c.env, {
    type: 'shift',
    action: 'closed',
    by: user.display_name || user.username,
  });
  scheduleLiveBroadcast(c.executionCtx, c.env, {
    type: 'shifts',
    action: 'closed',
    by: user.display_name || user.username,
  });

  return c.json({ success: true, ended_at: endedAt, stats });
});

async function getShiftStats(env: Env, shiftId: string) {
  const [income, agencyNoPayment, agencyPayAtDoor, walkInCount, expense] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total, payment_method, COUNT(*) as count
       FROM transactions WHERE shift_id = ? AND amount > 0 GROUP BY payment_method`
    ).bind(shiftId).all(),
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM transactions WHERE shift_id = ? AND type = 'agency' AND amount = 0`
    ).bind(shiftId).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM transactions WHERE shift_id = ? AND type = 'agency' AND amount > 0`
    ).bind(shiftId).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) as count FROM transactions WHERE shift_id = ? AND type = 'walk_in'`
    ).bind(shiftId).first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count FROM expenses WHERE shift_id = ?`
    ).bind(shiftId).first<{ total: number; count: number }>(),
  ]);

  const incomeTotal = income.results.reduce((s, r) => s + ((r.total as number) || 0), 0);

  return {
    income_total: incomeTotal,
    income_by_method: income.results,
    agency_count: agencyNoPayment?.count || 0,
    agency_pay_at_door_count: agencyPayAtDoor?.count || 0,
    walk_in_count: walkInCount?.count || 0,
    expense_total: expense?.total || 0,
    expense_count: expense?.count || 0,
    net: incomeTotal - (expense?.total || 0),
  };
}

export default shifts;
