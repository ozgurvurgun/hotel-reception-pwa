import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { generateId, now, getClientInfo } from '../auth';
import { logAction } from '../audit';
import { requirePerm } from '../guard';
import { logRecordChange, listRecordChanges, transactionDiff } from '../record-history';
import { scheduleLiveBroadcast } from '../live';

type AppContext = { Bindings: Env; Variables: AppVariables };

type TransactionBody = {
  shift_id: string;
  type: 'income' | 'agency' | 'walk_in';
  room_number?: string;
  guest_name?: string;
  guest_surname?: string;
  amount?: number;
  payment_method?: string;
  agency_name?: string;
  description?: string;
  notes?: string;
};

function resolveTransaction(body: TransactionBody) {
  if (body.type === 'walk_in') {
    if (!body.amount || body.amount <= 0) return { error: 'Amount is required for walk-in' };
    return {
      amount: body.amount,
      payment_method: body.payment_method || 'cash',
      agency_name: null,
    };
  }

  if (body.type === 'agency') {
    if (!body.agency_name) return { error: 'Agency name is required' };
    const hasPayment = body.amount && body.amount > 0;
    return {
      amount: hasPayment ? body.amount! : 0,
      payment_method: hasPayment ? (body.payment_method || 'cash') : 'none',
      agency_name: body.agency_name,
    };
  }

  if (!body.amount || body.amount <= 0) return { error: 'Enter a valid amount' };
  return {
    amount: body.amount,
    payment_method: body.payment_method || 'cash',
    agency_name: null,
  };
}

const transactions = new Hono<AppContext>();

transactions.get('/', async (c) => {
  const shiftId = c.req.query('shift_id');
  if (!shiftId) return c.json({ error: 'shift_id is required' }, 400);

  const results = await c.env.DB.prepare(
    `SELECT t.*, u.display_name as created_by_name, u.username as created_by_username
     FROM transactions t
     LEFT JOIN users u ON t.created_by = u.id
     WHERE t.shift_id = ?
     ORDER BY t.created_at DESC`
  ).bind(shiftId).all();
  return c.json(results.results);
});

transactions.get('/:id/history', async (c) => {
  const denied = requirePerm(c, [
    'income.create', 'expense.create', 'guest_entry.create',
    'record.edit', 'record.delete', 'shift.view.all', 'shift.open', 'shift.close',
  ]);
  if (denied) return denied;

  const id = c.req.param('id');
  const existing = await c.env.DB.prepare(
    'SELECT id, created_at, created_by FROM transactions WHERE id = ?'
  ).bind(id).first<{ id: string; created_at: string; created_by: string }>();
  if (!existing) return c.json({ error: 'Record not found' }, 404);

  let items = await listRecordChanges(c.env, 'transaction', id);
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

transactions.post('/', async (c) => {
  const body = await c.req.json<TransactionBody>();

  const permMap = {
    income: 'income.create',
    agency: 'guest_entry.create',
    walk_in: 'guest_entry.create',
  } as const;
  if (!body.type || !(body.type in permMap)) {
    return c.json({ error: 'Invalid record type' }, 400);
  }
  const denied = requirePerm(c, permMap[body.type as keyof typeof permMap]);
  if (denied) return denied;

  const user = c.get('user');
  const client = getClientInfo(c.req.raw);

  const shift = await c.env.DB.prepare(
    'SELECT id, user_id, status FROM shifts WHERE id = ?'
  ).bind(body.shift_id).first<{ id: string; user_id: string; status: string }>();

  if (!shift || shift.status !== 'open') {
    return c.json({ error: 'No open shift found' }, 400);
  }

  const resolved = resolveTransaction(body);
  if ('error' in resolved) return c.json({ error: resolved.error }, 400);

  const id = generateId();
  const createdAt = now();
  await c.env.DB.prepare(
    `INSERT INTO transactions (id, shift_id, type, room_number, guest_name, guest_surname,
      amount, payment_method, agency_name, description, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, body.shift_id, body.type,
    body.room_number || null, body.guest_name || null, body.guest_surname || null,
    resolved.amount, resolved.payment_method, resolved.agency_name,
    body.description || null, body.notes || null,
    user.sub, createdAt
  ).run();

  const actionMap = {
    income: 'INCOME_CREATED',
    agency: resolved.amount > 0 ? 'AGENCY_PAY_AT_DOOR_CREATED' : 'AGENCY_ENTRY_CREATED',
    walk_in: 'WALK_IN_CREATED',
  };

  await Promise.all([
    logAction(c.env, {
      userId: user.sub, username: user.username,
      action: actionMap[body.type],
      entityType: 'transaction', entityId: id,
      details: body as Record<string, unknown>,
      ip: client.ip, userAgent: client.userAgent,
    }),
    logRecordChange(c.env, {
      entityType: 'transaction',
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

  return c.json({ id, ...body, amount: resolved.amount, payment_method: resolved.payment_method, created_at: createdAt }, 201);
});

transactions.put('/:id', async (c) => {
  const denied = requirePerm(c, 'record.edit');
  if (denied) return denied;

  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const client = getClientInfo(c.req.raw);

  const existing = await c.env.DB.prepare('SELECT * FROM transactions WHERE id = ?')
    .bind(id).first<Record<string, unknown> & { created_by: string; shift_id: string }>();
  if (!existing) return c.json({ error: 'Record not found' }, 404);

  if (user.role !== 'root' && existing.created_by !== user.sub) {
    return c.json({ error: 'You can only edit your own records' }, 403);
  }

  const allowed = [
    'room_number', 'guest_name', 'guest_surname', 'amount', 'payment_method',
    'agency_name', 'description', 'notes', 'created_at',
  ];
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

  const changes = transactionDiff(existing, applied);
  if (!changes.length) return c.json({ error: 'No changes' }, 400);

  updates.push('updated_at = ?');
  values.push(now(), id);

  await c.env.DB.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values).run();

  await Promise.all([
    logAction(c.env, {
      userId: user.sub, username: user.username, action: 'TRANSACTION_UPDATED',
      entityType: 'transaction', entityId: id,
      details: { before: existing, after: applied },
      ip: client.ip, userAgent: client.userAgent,
    }),
    logRecordChange(c.env, {
      entityType: 'transaction',
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

transactions.delete('/:id', async (c) => {
  const denied = requirePerm(c, 'record.delete');
  if (denied) return denied;

  const user = c.get('user');
  const id = c.req.param('id');
  const client = getClientInfo(c.req.raw);

  const existing = await c.env.DB.prepare('SELECT * FROM transactions WHERE id = ?')
    .bind(id).first<Record<string, unknown> & { created_by: string; shift_id: string }>();
  if (!existing) return c.json({ error: 'Record not found' }, 404);

  if (user.role !== 'root' && existing.created_by !== user.sub) {
    return c.json({ error: 'You can only delete your own records' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM transactions WHERE id = ?').bind(id).run();

  await Promise.all([
    logAction(c.env, {
      userId: user.sub, username: user.username, action: 'TRANSACTION_DELETED',
      entityType: 'transaction', entityId: id,
      details: { deleted: existing },
      ip: client.ip, userAgent: client.userAgent,
    }),
    logRecordChange(c.env, {
      entityType: 'transaction',
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

export default transactions;
