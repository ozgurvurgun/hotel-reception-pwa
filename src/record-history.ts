import type { Env } from './types';
import { generateId, now } from './auth';

export type RecordEntityType = 'transaction' | 'expense';
export type RecordChangeAction = 'created' | 'updated' | 'deleted';

export type FieldChange = {
  field: string;
  from: unknown;
  to: unknown;
};

const TX_FIELDS = [
  'room_number', 'guest_name', 'guest_surname', 'amount', 'payment_method',
  'agency_name', 'description', 'notes', 'created_at',
] as const;

const EXP_FIELDS = [
  'category', 'description', 'amount', 'payment_method', 'vendor', 'notes', 'created_at',
] as const;

function normalize(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'number') return String(value);
  return String(value);
}

export function diffRecordFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[]
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (after[field] === undefined) continue;
    const fromVal = before[field];
    const toVal = after[field];
    if (normalize(fromVal) === normalize(toVal)) continue;
    changes.push({ field, from: fromVal ?? null, to: toVal ?? null });
  }
  return changes;
}

export function transactionDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): FieldChange[] {
  return diffRecordFields(before, after, TX_FIELDS);
}

export function expenseDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): FieldChange[] {
  return diffRecordFields(before, after, EXP_FIELDS);
}

export async function logRecordChange(
  env: Env,
  params: {
    entityType: RecordEntityType;
    entityId: string;
    shiftId?: string | null;
    userId?: string | null;
    userName?: string | null;
    action: RecordChangeAction;
    changes?: FieldChange[];
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO record_change_logs
      (id, entity_type, entity_id, shift_id, user_id, user_name, action, changes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    generateId(),
    params.entityType,
    params.entityId,
    params.shiftId || null,
    params.userId || null,
    params.userName || null,
    params.action,
    JSON.stringify(params.changes || []),
    now()
  ).run();
}

export async function listRecordChanges(
  env: Env,
  entityType: RecordEntityType,
  entityId: string
): Promise<Array<{
  id: string;
  action: RecordChangeAction;
  user_name: string | null;
  changes: FieldChange[];
  created_at: string;
}>> {
  const rows = await env.DB.prepare(
    `SELECT id, action, user_name, changes, created_at
     FROM record_change_logs
     WHERE entity_type = ? AND entity_id = ?
     ORDER BY created_at ASC`
  ).bind(entityType, entityId).all<{
    id: string;
    action: RecordChangeAction;
    user_name: string | null;
    changes: string;
    created_at: string;
  }>();

  return (rows.results || []).map((r) => {
    let changes: FieldChange[] = [];
    try {
      const parsed = JSON.parse(r.changes || '[]');
      changes = Array.isArray(parsed) ? parsed : [];
    } catch {
      changes = [];
    }
    return {
      id: r.id,
      action: r.action,
      user_name: r.user_name,
      changes,
      created_at: r.created_at,
    };
  });
}
