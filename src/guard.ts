import type { Context } from 'hono';
import type { Env, AppVariables } from './types';
import { hasPermission, type Permission } from './permissions';

type GuardContext = { Bindings: Env; Variables: AppVariables };

export function requirePerm(c: Context<GuardContext>, perm: Permission | Permission[]) {
  const user = c.get('user');
  const permissions = c.get('permissions') || [];
  if (!hasPermission(user.role, permissions, perm)) {
    return c.json({ error: 'You do not have permission' }, 403);
  }
  return null;
}

export function requireRoot(c: Context<GuardContext>) {
  const user = c.get('user');
  if (user.role !== 'root') {
    return c.json({ error: 'This action can only be performed by an administrator' }, 403);
  }
  return null;
}
