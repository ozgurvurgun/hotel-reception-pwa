import { buildPushHTTPRequest } from '@pushforge/builder';
import type { Env } from './types';
import { parsePermissions, hasPermission } from './permissions';

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

interface PushSubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  role: string;
  permissions: string;
}

function formatIstanbulDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function base64UrlToBytes(value: string): Uint8Array {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** Accept PushForge JWK JSON or classic web-push base64url private key. */
function toPrivateJwk(privateKey: string, publicKey: string): JsonWebKey {
  const trimmed = privateKey.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as JsonWebKey;
  }

  const priv = base64UrlToBytes(trimmed);
  const pub = base64UrlToBytes(publicKey.trim());
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('Invalid VAPID public key');
  }
  if (priv.length !== 32) {
    throw new Error('Invalid VAPID private key');
  }

  return {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(pub.subarray(1, 33)),
    y: bytesToBase64Url(pub.subarray(33, 65)),
    d: bytesToBase64Url(priv),
  };
}

async function listReceiveSubscriptions(env: Env): Promise<PushSubRow[]> {
  const rows = await env.DB.prepare(
    `SELECT ps.endpoint, ps.p256dh, ps.auth, u.role, u.permissions
     FROM push_subscriptions ps
     JOIN users u ON u.id = ps.user_id
     WHERE u.is_active = 1`
  ).all<PushSubRow>();

  return (rows.results || []).filter((row) =>
    hasPermission(row.role, parsePermissions(row.role, row.permissions), 'push.receive')
  );
}

async function deliverToSubscriptions(
  env: Env,
  subscriptions: PushSubRow[],
  payload: PushPayload
): Promise<number> {
  if (!subscriptions.length) return 0;

  const privateJWK = toPrivateJwk(env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY);
  const notification = {
    title: payload.title,
    body: payload.body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: payload.data || {},
    tag: payload.data?.shiftId || 'golden-gate',
    renotify: true,
  };

  const results = await Promise.allSettled(
    subscriptions.map(async (sub) => {
      const { endpoint, headers, body } = await buildPushHTTPRequest({
        privateJWK,
        subscription: {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        message: {
          payload: notification,
          adminContact: env.VAPID_SUBJECT,
          options: {
            ttl: 86400,
            urgency: 'high',
            topic: payload.data?.type || 'shift',
          },
        },
      });

      const res = await fetch(endpoint, { method: 'POST', headers, body });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
          .bind(sub.endpoint).run();
        return false;
      }
      return res.status === 201 || res.status === 200;
    })
  );

  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}

export async function sendPushToUser(env: Env, userId: string, payload: PushPayload): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT ps.endpoint, ps.p256dh, ps.auth, u.role, u.permissions
     FROM push_subscriptions ps
     JOIN users u ON u.id = ps.user_id
     WHERE ps.user_id = ? AND u.is_active = 1`
  ).bind(userId).all<PushSubRow>();

  const targets = (rows.results || []).filter((row) =>
    hasPermission(row.role, parsePermissions(row.role, row.permissions), 'push.receive')
  );
  return deliverToSubscriptions(env, targets, payload);
}

export async function sendShiftOpenedNotification(
  env: Env,
  {
    shiftId,
    userName,
    startedAt,
  }: { shiftId: string; userName: string; startedAt: string }
): Promise<void> {
  const subscriptions = await listReceiveSubscriptions(env);
  if (!subscriptions.length) return;

  await deliverToSubscriptions(env, subscriptions, {
    title: 'Shift opened',
    body: `${userName} · ${formatIstanbulDateTime(startedAt)}`,
    data: { shiftId, type: 'shift_opened' },
  });
}

export async function sendShiftSummaryNotifications(env: Env, shiftId: string): Promise<void> {
  const [subscriptions, shift, incomes, agencyNoPayment, agencyPayAtDoor, walkInCount, expenses, txCount] =
    await Promise.all([
      listReceiveSubscriptions(env),
      env.DB.prepare(
        `SELECT s.*, u.display_name as user_name FROM shifts s
         JOIN users u ON s.user_id = u.id WHERE s.id = ?`
      ).bind(shiftId).first<{
        user_name: string;
        started_at: string;
        ended_at: string;
        closing_notes: string;
      }>(),
      env.DB.prepare(
        `SELECT SUM(amount) as total, payment_method FROM transactions
         WHERE shift_id = ? AND amount > 0 GROUP BY payment_method`
      ).bind(shiftId).all<{ total: number; payment_method: string }>(),
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
        `SELECT SUM(amount) as total FROM expenses WHERE shift_id = ?`
      ).bind(shiftId).first<{ total: number }>(),
      env.DB.prepare(
        'SELECT COUNT(*) as count FROM transactions WHERE shift_id = ?'
      ).bind(shiftId).first<{ count: number }>(),
    ]);

  if (!shift) return;

  const incomeTotal = incomes.results.reduce((s, i) => s + (i.total || 0), 0);
  const expenseTotal = expenses?.total || 0;

  const methodLabels: Record<string, string> = {
    cash: 'Cash',
    credit_card: 'Credit Card',
    transfer: 'Transfer',
  };

  const incomeBreakdown = incomes.results
    .map((i) => `${methodLabels[i.payment_method] || i.payment_method}: ₺${(i.total || 0).toFixed(2)}`)
    .join(', ');

  const body = [
    `${shift.user_name} · ${shift.ended_at ? formatIstanbulDateTime(shift.ended_at) : '—'}`,
    `Started: ${formatIstanbulDateTime(shift.started_at)}`,
    `Records: ${txCount?.count || 0} income/entry`,
    `Income: ₺${incomeTotal.toFixed(2)}${incomeBreakdown ? ` (${incomeBreakdown})` : ''}`,
    `Expense: ₺${expenseTotal.toFixed(2)}`,
    `Agency (no payment): ${agencyNoPayment?.count || 0}`,
    `Agency (pay at door): ${agencyPayAtDoor?.count || 0}`,
    `Walk-in: ${walkInCount?.count || 0}`,
    shift.closing_notes ? `Note: ${shift.closing_notes}` : '',
  ].filter(Boolean).join('\n');

  await Promise.all([
    deliverToSubscriptions(env, subscriptions, {
      title: 'Shift closed',
      body,
      data: { shiftId, type: 'shift_closed' },
    }),
    env.DB.prepare('UPDATE shifts SET summary_sent = 1 WHERE id = ?').bind(shiftId).run(),
  ]);
}

/** Run push work after the HTTP response (Cloudflare waitUntil). */
export function schedulePush(
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  task: Promise<unknown>
): void {
  const safe = task.catch(() => {});
  if (ctx) ctx.waitUntil(safe);
  else void safe;
}
