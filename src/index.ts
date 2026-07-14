import { Hono } from 'hono';
import type { Env, AppVariables } from './types';
import { verifyToken, ensureRootUser } from './auth';
import { parsePermissions } from './permissions';
import authRoutes from './routes/auth';
import shiftsRoutes from './routes/shifts';
import transactionsRoutes from './routes/transactions';
import expensesRoutes from './routes/expenses';
import searchRoutes from './routes/search';
import reportsRoutes from './routes/reports';
import { audit, push } from './routes/misc';
import { getLiveDeskStub } from './live';

export { LiveDesk } from './live-desk';

type AppContext = { Bindings: Env; Variables: AppVariables };

const app = new Hono<AppContext>();

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/auth/login') {
    await ensureRootUser(c.env);
    await next();
    return;
  }
  await next();
});

app.route('/api/auth', authRoutes);

app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

/** WebSocket live desk - token via query (browser WS cannot set Authorization). */
app.get('/api/live', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.json({ error: 'WebSocket required' }, 426);
  }

  const token =
    c.req.query('token')
    || (c.req.header('Authorization')?.startsWith('Bearer ')
      ? c.req.header('Authorization')!.slice(7)
      : '');

  if (!token) return c.json({ error: 'Authorization required' }, 401);

  const payload = await verifyToken(token, c.env.JWT_SECRET);
  if (!payload) return c.json({ error: 'Invalid token' }, 401);

  const dbUser = await c.env.DB.prepare(
    'SELECT role, permissions, is_active FROM users WHERE id = ?'
  ).bind(payload.sub).first<{ role: string; permissions: string; is_active: number }>();

  if (!dbUser || !dbUser.is_active) {
    return c.json({ error: 'Account is not active' }, 403);
  }

  const stub = getLiveDeskStub(c.env);
  if (!stub) return c.json({ error: 'Live connection unavailable' }, 503);

  return stub.fetch(c.req.raw);
});

const protected_ = new Hono<AppContext>();
protected_.use('/*', async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return c.json({ error: 'Authorization required' }, 401);
  }
  const payload = await verifyToken(header.slice(7), c.env.JWT_SECRET);
  if (!payload) return c.json({ error: 'Invalid token' }, 401);

  const dbUser = await c.env.DB.prepare(
    'SELECT role, permissions, is_active FROM users WHERE id = ?'
  ).bind(payload.sub).first<{ role: string; permissions: string; is_active: number }>();

  if (!dbUser || !dbUser.is_active) {
    return c.json({ error: 'Account is not active' }, 403);
  }

  const permissions = parsePermissions(dbUser.role, dbUser.permissions);
  c.set('user', { ...payload, role: dbUser.role, permissions });
  c.set('permissions', permissions);
  await next();
});

protected_.route('/shifts', shiftsRoutes);
protected_.route('/transactions', transactionsRoutes);
protected_.route('/expenses', expensesRoutes);
protected_.route('/search', searchRoutes);
protected_.route('/reports', reportsRoutes);
protected_.route('/audit', audit);
protected_.route('/push', push);

app.route('/api', protected_);

app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    await ensureRootUser(env);
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    ctx.waitUntil(
      env.DB.prepare('DELETE FROM audit_logs WHERE created_at < ?').bind(cutoff).run()
    );
  },
};
