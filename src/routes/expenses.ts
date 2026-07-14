import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { generateId, now, getClientInfo } from '../auth';
import { logAction } from '../audit';
import { requirePerm } from '../guard';
import { logRecordChange, listRecordChanges, expenseDiff } from '../record-history';
import { scheduleLiveBroadcast } from '../live';

type AppContext = { Bindings: Env; Variables: AppVariables };

const expenses = new Hono<AppContext>();

expenses.get('/', async (c) => {
  const shiftId = c.req.query('shift_id');
  if (!shiftId) return c.json({ error: 'shift_id is required' }, 400);

  const results = await c.env.DB.prepare(
    `SELECT e.*, u.display_name as created_by_name, u.username as created_by_username
     FROM expenses e
     LEFT JOIN users u ON e.created_by = u.id
     WHERE e.shift_id = ?
     ORDER BY e.created_at DESC`
  ).bind(shiftId).all();
  return c.json(results.results);
});

expenses.get('/:id/history', async (c) => {
  const denied = requirePerm(c, [
    'income.create', 'expense.create', 'guest_entry.create',
    'record.edit', 'record.delete', 'shift.view.all', 'shift.open', 'shift.close',
  ]);
  if (denied) return denied;

  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    'SELECT id, created_at, created_by FROM expenses WHERE id = ?'
  ).bind(id).first<{ id: string; created_at: string; created_by: string }>();
  if (!existing) return c.json({ error: 'Record not found' }, 404);

  let items = await listRecordChanges(c.env, 'expense', id);
  if (!items.length) {
    const creator = await c.env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(existing.created_by).first<{ display_name: string }>();
    items = [{
      id: 'synthetic-created',
      action: 'created',
      user_name: creator?.display_name || null,
      changes: [],
      created_at: existing.created_at,
    }];
  }

  return c.json({ items });
});

expenses.post('/', async (c) => {
  const denied = requirePerm(c, 'expense.create');
  if (denied) return denied;

  const user = c.get('user');
  const body = await c.req.json<{
    shift_id: string;
    category: string;
    description: string;
    amount: number;
    payment_method: string;
    vendor?: string;
    notes?: string;
  }>();
  const client = getClientInfo(c.req.raw);

  const shift = await c.env.DB.prepare(
    'SELECT id, user_id, status FROM shifts WHERE id = ?'
  ).bind(body.shift_id).first<{ id: string; user_id: string; status: string }>();

  if (!shift || shift.status !== 'open') {
    return c.json({ error: 'No open shift found' }, 400);
  }

  if (!body.description || !body.amount || body.amount <= 0) {
    return c.json({ error: 'Description and amount are required' }, 400);
  }

  const id = generateId();
  const createdAt = now();
  await c.env.DB.prepare(
    `INSERT INTO expenses (id, shift_id, category, description, amount, payment_method, vendor, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, body.shift_id, body.category || 'diger', body.description,
    body.amount, body.payment_method || 'cash',
    body.vendor || null, body.notes || null, user.sub, createdAt
  ).run();

  await Promise.all([
    logAction(c.env, {
      userId: user.sub, username: user.username, action: 'EXPENSE_CREATED',
      entityType: 'expense', entityId: id,
      details: body as Record<string, unknown>,
      ip: client.ip, userAgent: client.userAgent,
    }),
    logRecordChange(c.env, {
      entityType: 'expense',
      entityId: id,
      shiftId: body.shift_id,
      userId: user.sub,
      userName: user.display_name || user.username,
      action: 'created',
      changes: [],
    }),
  ]);

  scheduleLiveBroadcast(c.executionCtx, c.env, {
    type: 'records',
    action: 'created',
    by: user.display_name || user.username,
  });

  return c.json({ id, ...body, created_at: createdAt }, 201);
});

expenses.put('/:id', async (c) => {
  const denied = requirePerm(c, 'record.edit');
  if (denied) return denied;

  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const client = getClientInfo(c.req.raw);

  const existing = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?')
    .bind(id).first<Record<string, unknown> & { created_by: string; shift_id: string }>();
  if (!existing) return c.json({ error: 'Record not found' }, 404);

  if (user.role !== 'root' && existing.created_by !== user.sub) {
    return c.json({ error: 'You can only edit your own records' }, 403);
  }

  const allowed = ['category', 'description', 'amount', 'payment_method', 'vendor', 'notes', 'created_at'];
  const updates: string[] = [];
  const values: unknown[] = [];
  const applied: Record<string, unknown> = {};

  for (const key of allowed) {
    if (body[key] !== undefined) {
      if (key === 'created_at') {
        const raw = String(body[key] || '');
        const parsed = new Date(raw);
        if (!raw || Number.isNaN(parsed.getTime())) {
          return c.json({ error: 'Invalid date' }, 400);
        }
        const iso = parsed.toISOString();
        updates.push('created_at = ?');
        values.push(iso);
        applied.created_at = iso;
        continue;
      }
      updates.push(`${key} = ?`);
      values.push(body[key]);
      applied[key] = body[key];
    }
  }

  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);

  const changes = expenseDiff(existing, applied);
  if (!changes.length) return c.json({ error: 'No changes' }, 400);

  updates.push('updated_at = ?');
  values.push(now(), id);

  await c.env.DB.prepare(`UPDATE expenses SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values).run();

  await Promise.all([
    logAction(c.env, {
      userId: user.sub, username: user.username, action: 'EXPENSE_UPDATED',
      entityType: 'expense', entityId: id,
      details: { before: existing, after: applied },
      ip: client.ip, userAgent: client.userAgent,
    }),
    logRecordChange(c.env, {
      entityType: 'expense',
      entityId: id,
      shiftId: existing.shift_id,
      userId: user.sub,
      userName: user.display_name || user.username,
      action: 'updated',
      changes,
    }),
  ]);

  scheduleLiveBroadcast(c.executionCtx, c.env, {
    type: 'records',
    action: 'updated',
    by: user.display_name || user.username,
  });

  return c.json({ success: true, changes });
});

expenses.delete('/:id', async (c) => {
  const denied = requirePerm(c, 'record.delete');
  if (denied) return denied;

  const user = c.get('user');
  const id = c.req.param('id');
  const client = getClientInfo(c.req.raw);

  const existing = await c.env.DB.prepare('SELECT * FROM expenses WHERE id = ?')
    .bind(id).first<Record<string, unknown> & { created_by: string; shift_id: string }>();
  if (!existing) return c.json({ error: 'Record not found' }, 404);

  if (user.role !== 'root' && existing.created_by !== user.sub) {
    return c.json({ error: 'You can only delete your own records' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run();

  await Promise.all([
    logAction(c.env, {
      userId: user.sub, username: user.username, action: 'EXPENSE_DELETED',
      entityType: 'expense', entityId: id,
      details: { deleted: existing },
      ip: client.ip, userAgent: client.userAgent,
    }),
    logRecordChange(c.env, {
      entityType: 'expense',
      entityId: id,
      shiftId: existing.shift_id,
      userId: user.sub,
      userName: user.display_name || user.username,
      action: 'deleted',
      changes: [],
    }),
  ]);

  scheduleLiveBroadcast(c.executionCtx, c.env, {
    type: 'records',
    action: 'deleted',
    by: user.display_name || user.username,
  });

  return c.json({ success: true });
});

export default expenses;
