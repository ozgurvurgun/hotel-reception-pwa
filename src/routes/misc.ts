import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { generateId, now, getClientInfo } from '../auth';
import { logAction } from '../audit';
import { requirePerm } from '../guard';
import { schedulePush } from '../push';

type AppContext = { Bindings: Env; Variables: AppVariables };

const audit = new Hono<AppContext>();

audit.get('/actions', async (c) => {
  const denied = requirePerm(c, 'audit.view');
  if (denied) return denied;

  const results = await c.env.DB.prepare(
    'SELECT DISTINCT action FROM audit_logs ORDER BY action ASC'
  ).all<{ action: string }>();

  return c.json(results.results.map((r) => r.action));
});

audit.get('/', async (c) => {
  const denied = requirePerm(c, 'audit.view');
  if (denied) return denied;

  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10), 200);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10), 0);
  const action = c.req.query('action');
  const userId = c.req.query('user_id');
  const q = c.req.query('q')?.trim();
  const from = c.req.query('from');
  const to = c.req.query('to');

  let query = 'SELECT * FROM audit_logs WHERE 1=1';
  const params: unknown[] = [];

  if (action) { query += ' AND action = ?'; params.push(action); }
  if (userId) { query += ' AND user_id = ?'; params.push(userId); }
  if (from) { query += ' AND created_at >= ?'; params.push(from); }
  if (to) { query += ' AND created_at < ?'; params.push(to); }
  if (q) {
    const pattern = `%${q}%`;
    query += ` AND (username LIKE ? OR action LIKE ? OR details LIKE ?
      OR entity_type LIKE ? OR entity_id LIKE ? OR ip_address LIKE ?)`;
    params.push(pattern, pattern, pattern, pattern, pattern, pattern);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit + 1, offset);

  const results = await c.env.DB.prepare(query).bind(...params).all();
  const rows = results.results;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    items,
    pagination: {
      limit,
      offset,
      hasMore,
    },
  });
});

const push = new Hono<AppContext>();

push.post('/subscribe', async (c) => {
  const denied = requirePerm(c, 'push.subscribe');
  if (denied) return denied;

  const user = c.get('user');
  const subscription = await c.req.json<{
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }>();
  const client = getClientInfo(c.req.raw);

  if (!subscription?.endpoint || !subscription?.keys) {
    return c.json({ error: 'Invalid subscription' }, 400);
  }

  const id = generateId();
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = ?, p256dh = ?, auth = ?, created_at = ?`
  ).bind(
    id, user.sub, subscription.endpoint,
    subscription.keys.p256dh, subscription.keys.auth, now(),
    user.sub, subscription.keys.p256dh, subscription.keys.auth, now()
  ).run();

  // Keep at most 5 subscriptions per user (drop oldest stale device tokens)
  const existing = await c.env.DB.prepare(
    `SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(user.sub).all<{ id: string }>();
  const staleIds = (existing.results || []).slice(5).map((r) => r.id);
  if (staleIds.length) {
    await Promise.all(
      staleIds.map((sid) =>
        c.env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sid).run()
      )
    );
  }

  schedulePush(
    c.executionCtx,
    logAction(c.env, {
      userId: user.sub, username: user.username, action: 'PUSH_SUBSCRIBED',
      ip: client.ip, userAgent: client.userAgent,
    })
  );

  return c.json({ success: true });
});

push.delete('/subscribe', async (c) => {
  const denied = requirePerm(c, 'push.subscribe');
  if (denied) return denied;

  const user = c.get('user');
  const { endpoint } = await c.req.json<{ endpoint: string }>();
  const client = getClientInfo(c.req.raw);

  await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?')
    .bind(user.sub, endpoint).run();

  await logAction(c.env, {
    userId: user.sub, username: user.username, action: 'PUSH_UNSUBSCRIBED',
    ip: client.ip, userAgent: client.userAgent,
  });

  return c.json({ success: true });
});

push.get('/vapid-key', async (c) => {
  const denied = requirePerm(c, 'push.subscribe');
  if (denied) return denied;
  return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY });
});

export { audit, push };
