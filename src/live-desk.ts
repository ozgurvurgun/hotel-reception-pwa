import type { Env } from './types';

export type LiveEvent = {
  type: 'shift' | 'records' | 'shifts' | 'hello';
  action?: string;
  at?: string;
  by?: string;
};

/**
 * Single hotel-desk pub/sub hub. All authenticated clients share one DO instance.
 */
export class LiveDesk {
  constructor(private ctx: DurableObjectState, _env: Env) {
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const event = await request.json<LiveEvent>().catch(() => null);
      if (!event?.type) return new Response('Bad event', { status: 400 });
      this.broadcast({ ...event, at: event.at || new Date().toISOString() });
      return new Response('ok');
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    if (message === 'ping') {
      try { ws.send('pong'); } catch { /* ignore */ }
    }
  }

  async webSocketClose(ws: WebSocket) {
    try { ws.close(); } catch { /* ignore */ }
  }

  async webSocketError(ws: WebSocket) {
    try { ws.close(1011, 'error'); } catch { /* ignore */ }
  }

  private broadcast(event: LiveEvent) {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        /* drop dead sockets */
      }
    }
  }
}
