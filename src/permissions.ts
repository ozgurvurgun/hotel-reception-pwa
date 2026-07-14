export const PERMISSION_GROUPS = [
  {
    id: 'shift',
    label: 'Shift',
    permissions: [
      { key: 'shift.open', label: 'Open shift' },
      { key: 'shift.close', label: 'Close shift' },
      { key: 'shift.view.all', label: 'View all shifts' },
    ],
  },
  {
    id: 'records',
    label: 'Records',
    permissions: [
      { key: 'income.create', label: 'Add income' },
      { key: 'expense.create', label: 'Add expense' },
      { key: 'guest_entry.create', label: 'Guest entry' },
      { key: 'record.edit', label: 'Edit record' },
      { key: 'record.delete', label: 'Delete record' },
    ],
  },
  {
    id: 'search',
    label: 'Search',
    permissions: [
      { key: 'search.use', label: 'Use search' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    permissions: [
      { key: 'audit.view', label: 'System logs' },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    permissions: [
      { key: 'push.subscribe', label: 'Push notification subscription' },
      { key: 'push.receive', label: 'Receive shift summary notifications' },
    ],
  },
  {
    id: 'extras',
    label: 'Other',
    permissions: [
      { key: 'easter_egg.access', label: 'Music player' },
    ],
  },
] as const;

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.key)
);

export type Permission = (typeof ALL_PERMISSIONS)[number];

export function parsePermissions(role: string, raw: string | null | undefined): string[] {
  if (role === 'root') return [...ALL_PERMISSIONS];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p) => ALL_PERMISSIONS.includes(p)) : [];
  } catch {
    return [];
  }
}

export function hasPermission(
  role: string,
  permissions: string[],
  required: Permission | Permission[]
): boolean {
  if (role === 'root') return true;
  const needed = Array.isArray(required) ? required : [required];
  return needed.some((p) => permissions.includes(p));
}

export function canViewShift(
  role: string,
  permissions: string[],
  shiftUserId: string,
  currentUserId: string
): boolean {
  if (shiftUserId === currentUserId) return true;
  return hasPermission(role, permissions, 'shift.view.all');
}
