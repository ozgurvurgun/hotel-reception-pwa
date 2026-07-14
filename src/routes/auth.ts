import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { verifyToken, hashPassword, verifyPassword, createToken, generateId, now, getClientInfo, ensureRootUser } from '../auth';
import { logAction } from '../audit';
import { PERMISSION_GROUPS, ALL_PERMISSIONS, parsePermissions } from '../permissions';
import { requireRoot } from '../guard';

type AppContext = { Bindings: Env; Variables: AppVariables };

const auth = new Hono<AppContext>();

auth.post('/login', async (c) => {
  await ensureRootUser(c.env);
  const { username, password } = await c.req.json<{ username: string; password: string }>();
  const client = getClientInfo(c.req.raw);

  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE username = ? AND is_active = 1'
  ).bind(username).first<{
    id: string; username: string; password_hash: string;
    display_name: string; role: string; permissions: string;
  }>();

  if (!user) {
    await logAction(c.env, { action: 'LOGIN_FAILED', details: { username }, ...client });
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    await logAction(c.env, { action: 'LOGIN_FAILED', details: { username }, ...client });
    return c.json({ error: 'Invalid username or password' }, 401);
  }

  const permissions = parsePermissions(user.role, user.permissions);
  const token = await createToken({
    sub: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name,
    permissions,
  }, c.env.JWT_SECRET);

  await logAction(c.env, {
    userId: user.id, username: user.username, action: 'LOGIN_SUCCESS',
    ip: client.ip, userAgent: client.userAgent,
  });

  return c.json({
    token,
    user: {
      id: user.id, username: user.username, display_name: user.display_name,
      role: user.role, permissions,
    },
  });
});

auth.use('/*', async (c, next) => {
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

auth.get('/permissions', (c) => {
  return c.json({ groups: PERMISSION_GROUPS, all: ALL_PERMISSIONS });
});

auth.get('/me', async (c) => {
  const user = c.get('user');
  const permissions = c.get('permissions');
  return c.json({
    user: {
      id: user.sub,
      sub: user.sub,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      permissions,
    },
  });
});

auth.post('/users', async (c) => {
  const denied = requireRoot(c);
  if (denied) return denied;

  const current = c.get('user');
  const { username, password, display_name, permissions } = await c.req.json<{
    username: string; password: string; display_name: string; permissions?: string[];
  }>();

  if (!username || !password || !display_name) {
    return c.json({ error: 'All fields are required' }, 400);
  }

  const validPerms = (permissions || []).filter((p) => ALL_PERMISSIONS.includes(p as typeof ALL_PERMISSIONS[number]));
  const hash = await hashPassword(password);
  const id = generateId();
  const client = getClientInfo(c.req.raw);

  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, username, password_hash, display_name, role, permissions, is_active, created_at, created_by)
       VALUES (?, ?, ?, ?, 'staff', ?, 1, ?, ?)`
    ).bind(id, username, hash, display_name, JSON.stringify(validPerms), now(), current.sub).run();
  } catch {
    return c.json({ error: 'Username already exists' }, 409);
  }

  await logAction(c.env, {
    userId: current.sub, username: current.username, action: 'USER_CREATED',
    entityType: 'user', entityId: id,
    details: { username, display_name, permissions: validPerms },
    ip: client.ip, userAgent: client.userAgent,
  });

  return c.json({ id, username, display_name, role: 'staff', permissions: validPerms }, 201);
});

auth.get('/users', async (c) => {
  const denied = requireRoot(c);
  if (denied) return denied;

  const users = await c.env.DB.prepare(
    `SELECT id, username, display_name, role, permissions, is_active, created_at
     FROM users WHERE role != 'root' ORDER BY created_at DESC`
  ).all();

  const results = users.results.map((u) => ({
    ...u,
    permissions: parsePermissions(u.role as string, u.permissions as string),
  }));

  return c.json(results);
});

auth.patch('/users/:id', async (c) => {
  const denied = requireRoot(c);
  if (denied) return denied;

  const current = c.get('user');
  const id = c.req.param('id');
  const { is_active, display_name, password, permissions } = await c.req.json<{
    is_active?: boolean; display_name?: string; password?: string; permissions?: string[];
  }>();
  const client = getClientInfo(c.req.raw);

  const target = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: string }>();
  if (!target) return c.json({ error: 'User not found' }, 404);
  if (target.role === 'root') return c.json({ error: 'Root user cannot be edited' }, 403);

  const updates: string[] = [];
  const values: unknown[] = [];

  if (typeof is_active === 'boolean') { updates.push('is_active = ?'); values.push(is_active ? 1 : 0); }
  if (display_name) { updates.push('display_name = ?'); values.push(display_name); }
  if (password) { updates.push('password_hash = ?'); values.push(await hashPassword(password)); }
  if (permissions) {
    const validPerms = permissions.filter((p) => ALL_PERMISSIONS.includes(p as typeof ALL_PERMISSIONS[number]));
    updates.push('permissions = ?');
    values.push(JSON.stringify(validPerms));
  }

  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);

  values.push(id);
  await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();

  await logAction(c.env, {
    userId: current.sub, username: current.username, action: 'USER_UPDATED',
    entityType: 'user', entityId: id,
    details: { is_active, display_name, password_changed: !!password, permissions },
    ip: client.ip, userAgent: client.userAgent,
  });

  return c.json({ success: true });
});

export default auth;
