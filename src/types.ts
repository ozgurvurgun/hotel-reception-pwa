export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  LIVE_DESK: DurableObjectNamespace;
  ROOT_USERNAME: string;
  ROOT_PASSWORD: string;
  JWT_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

export interface User {
  id: string;
  username: string;
  display_name: string;
  role: 'root' | 'staff';
  is_active: number;
  created_at: string;
}

export interface JWTPayload {
  sub: string;
  username: string;
  role: string;
  display_name: string;
  permissions?: string[];
}

export type AppVariables = {
  user: JWTPayload;
  permissions: string[];
};

export type PaymentMethod = 'cash' | 'credit_card' | 'transfer' | 'agency' | 'none';
export type TransactionType = 'income' | 'agency' | 'walk_in';
export type ExpenseCategory = 'kahvalti' | 'temizlik' | 'market' | 'bakim' | 'personel' | 'diger';
