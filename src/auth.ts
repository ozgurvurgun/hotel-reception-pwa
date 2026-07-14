import { SignJWT, jwtVerify } from 'jose';
import type { Env, JWTPayload } from './types';

const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${saltHex}:${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const computed = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === hashHex;
}

export async function createToken(payload: JWTPayload, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key);
}

export async function verifyToken(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    return payload as unknown as JWTPayload;
  } catch {
    return null;
  }
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

export async function ensureRootUser(env: Env): Promise<void> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(env.ROOT_USERNAME)
    .first();
  if (existing) return;

  const hash = await hashPassword(env.ROOT_PASSWORD);
  await env.DB.prepare(
    `INSERT INTO users (id, username, password_hash, display_name, role, is_active, created_at)
     VALUES (?, ?, ?, ?, 'root', 1, ?)`
  ).bind(generateId(), env.ROOT_USERNAME, hash, 'Administrator', now()).run();
}

export function getClientInfo(request: Request): { ip: string; userAgent: string } {
  return {
    ip: request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown',
    userAgent: request.headers.get('User-Agent') || 'unknown',
  };
}
