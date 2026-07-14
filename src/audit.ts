import type { Env } from './types';
import { generateId, now } from './auth';

export async function logAction(
  env: Env,
  params: {
    userId?: string;
    username?: string;
    action: string;
    entityType?: string;
    entityId?: string;
    details?: Record<string, unknown>;
    ip?: string;
    userAgent?: string;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, user_id, username, action, entity_type, entity_id, details, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    generateId(),
    params.userId || null,
    params.username || null,
    params.action,
    params.entityType || null,
    params.entityId || null,
    params.details ? JSON.stringify(params.details) : null,
    params.ip || null,
    params.userAgent || null,
    now()
  ).run();
}
