// Agency list - update here when Nazlı sends the detailed list
export const AGENCIES_NO_PAYMENT = [
  'Tatilbudur',
  'ETS',
  'Enuygun',
  'Jolly Tur',
  'Setur',
  'TUI',
  'Expedia',
  'Otelz',
];

export const AGENCIES_PAY_AT_DOOR = [
  'Booking.com',
  'Agoda',
  'Hotels.com',
  'Hotels.com.tr',
];

// All agencies (combined list for search/forms)
export const ALL_AGENCIES = [
  ...AGENCIES_NO_PAYMENT,
  ...AGENCIES_PAY_AT_DOOR,
  'Other',
];

export const ENTRY_TYPES = {
  agency_no_payment: {
    label: 'Agency (unpaid)',
    shortLabel: 'Unpaid',
    icon: 'building',
    hint: '',
    type: 'agency',
    requiresAgency: true,
    requiresPayment: false,
  },
  agency_pay_at_door: {
    label: 'Agency (pay at door)',
    shortLabel: 'Pay at door',
    icon: 'credit-card',
    hint: '',
    type: 'agency',
    requiresAgency: true,
    requiresPayment: true,
  },
  walk_in: {
    label: 'Walk-in',
    shortLabel: 'Walk-in',
    icon: 'walk',
    hint: '',
    type: 'walk_in',
    requiresAgency: false,
    requiresPayment: true,
  },
};

export const TYPE_LABELS = {
  income: 'Income',
  agency: 'Agency',
  walk_in: 'Walk-in',
};

export function getTransactionTitle(t) {
  if (t.type === 'walk_in') {
    return `Walk-in · Room ${t.room_number || '-'}`;
  }
  if (t.type === 'agency') {
    const mode = (t.amount || 0) > 0 ? ' (pay at door)' : '';
    return `${t.agency_name}${mode}`;
  }
  return `Room ${t.room_number || '-'}`;
}

export function getTransactionSubtitle(t) {
  const guest = [t.guest_name, t.guest_surname].filter(Boolean).join(' ');
  if (t.type === 'agency' && !(t.amount > 0)) {
    return guest || 'Unpaid entry';
  }
  return guest;
}
