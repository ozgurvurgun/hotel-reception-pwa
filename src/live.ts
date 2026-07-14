import type { Env } from './types';
import type { LiveEvent } from './live-desk';

export function getLiveDeskStub(env: Env) {
  if (!env.LIVE_DESK) return null;
  return env.LIVE_DESK.get(env.LIVE_DESK.idFromName('main'));
}

/** Fire-and-forget desk broadcast (does not fail the API request). */
export function scheduleLiveBroadcast(
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  env: Env,
  event: LiveEvent
) {
  const stub = getLiveDeskStub(env);
  if (!stub) return;

  const run = stub.fetch('https://live-desk/broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  }).then((res) => {
    if (!res.ok) console.warn('live broadcast failed', res.status);
  }).catch((err) => console.warn('live broadcast error', err));

  if (ctx?.waitUntil) ctx.waitUntil(run);
  else void run;
}
