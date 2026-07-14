import API from './api.js';
import icon from './icons.js';
import {
  ALL_AGENCIES, ENTRY_TYPES, getTransactionTitle, getTransactionSubtitle,
} from './config.js';
import { downloadShiftExcel, downloadMonthlyExcel } from './shift-excel.js';

const PICKER_CARET_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const PAYMENT_LABELS = {
  cash: 'Cash', credit_card: 'Credit Card', transfer: 'Transfer', agency: 'Agency', none: '—',
};
const PAYMENT_BADGE = {
  cash: 'badge-cash', credit_card: 'badge-card', transfer: 'badge-transfer', agency: 'badge-agency',
};
const CATEGORIES = {
  kahvalti: { icon: 'coffee', label: 'Breakfast', color: '#E65100' },
  temizlik: { icon: 'cleaning', label: 'Cleaning', color: '#007AFF' },
  market: { icon: 'cart', label: 'Market', color: '#34C759' },
  bakim: { icon: 'wrench', label: 'Maintenance', color: '#8E8E93' },
  personel: { icon: 'person', label: 'Staff', color: '#5856D6' },
  diger: { icon: 'box', label: 'Other', color: '#FF9500' },
};

function paymentPill(value, iconName, label, active = false) {
  return `<div class="payment-pill${active ? ' active' : ''}" data-value="${value}">${icon(iconName, { size: 16 })}<span>${label}</span></div>`;
}

function emptyState(iconName, title, text = '') {
  return `<div class="empty-state">
    <div class="empty-state-icon">${icon(iconName, { size: 44, color: '#8E8E93' })}</div>
    <div class="empty-state-title">${title}</div>
    ${text ? `<div class="empty-state-text">${text}</div>` : ''}
  </div>`;
}

function noteIcon() {
  return icon('note', { size: 12, color: '#8E8E93', className: 'inline-icon' });
}
const AGENCIES = ALL_AGENCIES;

let state = {
  user: null,
  shift: null,
  shiftUserName: null,
  stats: null,
  searchType: 'guests',
  sheetCallback: null,
  sheetCloseOnSave: true,
  entryMode: 'agency_no_payment',
  permGroups: [],
  recordIndex: { transactions: {}, expenses: {} },
  editSession: null,
};

function hasPerm(...perms) {
  if (!state.user) return false;
  if (state.user.role === 'root') return true;
  const userPerms = state.user.permissions || [];
  return perms.some((p) => userPerms.includes(p));
}

function isRoot() {
  return state.user?.role === 'root';
}

function currentUserId() {
  return state.user?.id || state.user?.sub || null;
}

function canCloseActiveShift() {
  if (!state.user || !state.shift || !hasPerm('shift.close')) return false;
  if (state.user.role === 'root') return true;
  return state.shift.user_id === currentUserId();
}

function recordCreatorLabel(item) {
  return item.created_by_name || item.created_by_username || '';
}

function canMutateRecord(record) {
  if (!state.user || !record) return false;
  if (state.user.role === 'root') return true;
  return record.created_by === currentUserId();
}

function recordActionButtons(type, record) {
  const buttons = [];
  buttons.push(`<button type="button" class="log-btn" onclick="window.showRecordLog('${type}','${record.id}')">Log</button>`);
  if (hasPerm('record.edit') && canMutateRecord(record)) {
    buttons.push(`<button type="button" class="edit-btn" onclick="window.editRecord('${type}','${record.id}')">Edit</button>`);
  }
  if (hasPerm('record.delete') && canMutateRecord(record)) {
    buttons.push(`<button type="button" class="delete-btn" onclick="window.deleteRecord('${type}','${record.id}')">Delete</button>`);
  }
  return `<div class="record-actions">${buttons.join('')}</div>`;
}

function toDateTimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function fromDateTimeLocalValue(local) {
  if (!local) return null;
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const utcGuess = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+03:00`);
  if (Number.isNaN(utcGuess)) return null;
  return new Date(utcGuess).toISOString();
}

function paymentPillsHTML(selected = 'cash') {
  const methods = [
    ['cash', 'cash', 'Cash'],
    ['credit_card', 'credit-card', 'Credit Card'],
    ['transfer', 'transfer', 'Transfer'],
  ];
  return methods.map(([value, iconName, label]) =>
    paymentPill(value, iconName, label, selected === value)
  ).join('');
}

function editStepsBar(step, labels) {
  return `
    <div class="edit-steps" aria-hidden="true">
      ${labels.map((_, i) => `<div class="edit-step-dot${i === step ? ' active' : ''}${i < step ? ' done' : ''}"></div>`).join('')}
    </div>
    <div class="edit-step-label">Step ${step + 1}/${labels.length} · ${esc(labels[step])}</div>`;
}

function showConfirm({ title, message, confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const okBtn = $('#confirm-ok');
    okBtn.textContent = confirmText;
    okBtn.classList.toggle('danger', danger);
    $('#confirm-overlay').classList.add('open');
    lockBodyScroll();

    const done = (result) => {
      $('#confirm-overlay').classList.remove('open');
      unlockBodyScroll();
      okBtn.onclick = null;
      $('#confirm-cancel').onclick = null;
      $('#confirm-overlay').onclick = null;
      resolve(result);
    };

    okBtn.onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    $('#confirm-overlay').onclick = (e) => {
      if (e.target === $('#confirm-overlay')) done(false);
    };
  });
}

function renderPermissionSwitches(selected = [], prefix = 'perm') {
  if (!state.permGroups.length) {
    return '<p class="text-secondary text-sm">Loading permissions...</p>';
  }
  return state.permGroups.map((g) => `
    <div class="perm-group">
      <div class="perm-group-title">${esc(g.label)}</div>
      <div class="perm-list">
        ${g.permissions.map((p) => `
          <div class="perm-row">
            <span>${esc(p.label)}</span>
            <label class="perm-switch">
              <input type="checkbox" data-perm="${p.key}" ${selected.includes(p.key) ? 'checked' : ''}>
              <span class="perm-slider"></span>
            </label>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

function collectPermissions() {
  return [...$$('#sheet-body input[data-perm]')]
    .filter((el) => el.checked)
    .map((el) => el.dataset.perm);
}

function applyTabVisibility() {
  const rules = {
    home: () => hasPerm('shift.open', 'shift.close', 'income.create', 'expense.create', 'guest_entry.create'),
    records: () => hasPerm('income.create', 'expense.create', 'guest_entry.create', 'record.delete', 'record.edit'),
    search: () => hasPerm('search.use'),
    shifts: () => hasPerm('shift.open', 'shift.close', 'shift.view.all'),
    more: () => true,
  };
  $$('.tab-item').forEach((tab) => {
    tab.style.display = rules[tab.dataset.page]?.() ? '' : 'none';
  });
}

function vibrate(ms = 10) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

let bodyScrollLockCount = 0;
let bodyScrollY = 0;

function canScrollInsideLockedOverlay(target) {
  return !!target?.closest?.(
    '.sheet, .confirm-dialog, .easter-egg-modal, .picker-menu, .period-custom-dates'
  );
}

function onBodyScrollLockTouchMove(e) {
  if (canScrollInsideLockedOverlay(e.target)) return;
  e.preventDefault();
}

function lockBodyScroll() {
  if (bodyScrollLockCount === 0) {
    bodyScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.classList.add('scroll-locked');
    document.body.style.top = `-${bodyScrollY}px`;
    document.addEventListener('touchmove', onBodyScrollLockTouchMove, { passive: false });
  }
  bodyScrollLockCount += 1;
}

function unlockBodyScroll() {
  if (bodyScrollLockCount === 0) return;
  bodyScrollLockCount -= 1;
  if (bodyScrollLockCount > 0) return;
  document.removeEventListener('touchmove', onBodyScrollLockTouchMove);
  document.body.classList.remove('scroll-locked');
  document.body.style.top = '';
  window.scrollTo(0, bodyScrollY);
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  setTimeout(() => el.classList.remove('show'), 2500);
}

function formatMoney(n) {
  return `₺${(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Europe/Istanbul',
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit',
  });
}

function preventZoom() {
  const blockGesture = (e) => e.preventDefault();
  document.addEventListener('gesturestart', blockGesture, { passive: false });
  document.addEventListener('gesturechange', blockGesture, { passive: false });
  document.addEventListener('gestureend', blockGesture, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
}

function isEditableTarget(el) {
  if (!el || !(el instanceof Element)) return false;
  const node = el.closest?.('input, textarea, [contenteditable="true"]') || el;
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
  if (tag === 'INPUT') {
    const type = (node.getAttribute('type') || 'text').toLowerCase();
    if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden', 'range', 'color'].includes(type)) {
      return false;
    }
  }
  return !node.disabled && !node.readOnly;
}

function preventNonInputCopy() {
  const blockUnlessEditable = (e) => {
    if (isEditableTarget(e.target)) return;
    e.preventDefault();
  };
  document.addEventListener('copy', blockUnlessEditable, true);
  document.addEventListener('cut', blockUnlessEditable, true);
  document.addEventListener('selectstart', blockUnlessEditable, true);
  document.addEventListener('dragstart', blockUnlessEditable, true);
}

// --- Auth ---
function finishAuthBoot() {
  document.documentElement.classList.remove('auth-boot', 'auth-has-token', 'auth-no-token');
  document.documentElement.classList.add('auth-ready');
}

async function init() {
  preventZoom();
  preventNonInputCopy();

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      console.log('SW registered');
    } catch (e) {
      console.warn('SW failed:', e);
    }
  }

  try {
    if (API.token) {
      try {
        const { user } = await API.me();
        state.user = user;
        await showApp();
        return;
      } catch {
        API.setToken(null);
      }
    }
    showLogin();
  } finally {
    finishAuthBoot();
  }
}

const THEME_COLORS = {
  app: '#F2F2F7',
  login: '#FFFFFF',
  easterEgg: '#000000',
};

function setThemeColor(color) {
  const meta = $('#theme-color-meta') || document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', color);
  document.documentElement.style.backgroundColor = color;
}

function showLogin() {
  document.body.classList.add('login-mode');
  setThemeColor(THEME_COLORS.login);
  $('#login-page').classList.remove('hidden');
  $('#app').classList.add('hidden');
  disconnectLive();
}

function resetAppUiForSession() {
  try { closeSheet(); } catch { /* ignore */ }
  state.shift = null;
  state.stats = null;
  state.shiftUserName = null;
  state.recordIndex = { transactions: {}, expenses: {} };
  state.editSession = null;
  state.sheetCallback = null;
  state.sheetCloseOnSave = true;
  shiftsFiltersReady = false;
  shiftsFilterState.from = '';
  shiftsFilterState.to = '';
  shiftsPagination = { offset: 0, hasMore: false };
  auditPagination = { offset: 0, hasMore: false };

  const clearIds = [
    'more-content', 'records-content', 'shifts-list', 'search-results',
    'recent-activity', 'shift-banner', 'stats-grid', 'quick-actions',
  ];
  for (const id of clearIds) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  }
}

async function showApp() {
  document.body.classList.remove('login-mode');
  setThemeColor(THEME_COLORS.app);
  $('#login-page').classList.add('hidden');
  $('#app').classList.remove('hidden');
  resetAppUiForSession();
  try {
    const { groups } = await API.getPermissions();
    state.permGroups = groups;
  } catch { /* silent */ }
  applyTabVisibility();
  setupSearchFilters();
  navigateTo('home');
  connectLive();
  if (hasPerm('push.subscribe')) setupPushNotifications();
}

$('#login-toggle-pwd')?.addEventListener('click', () => {
  const input = $('#login-password');
  const btn = $('#login-toggle-pwd');
  if (!input || !btn) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.querySelector('.icon-eye-off')?.classList.toggle('hidden', show);
  btn.querySelector('.icon-eye')?.classList.toggle('hidden', !show);
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  try {
    const { token, user } = await API.login(username, password);
    API.setToken(token);
    state.user = user;
    vibrate();
    showApp();
    toast(`Welcome, ${user.display_name}!`);
  } catch (err) {
    toast(err.message, true);
  }
});

window.addEventListener('auth:logout', () => {
  disconnectLive();
  state.user = null;
  state.shift = null;
  resetAppUiForSession();
  showLogin();
});

// --- Navigation ---
$$('.tab-item').forEach((tab) => {
  tab.addEventListener('click', () => {
    const page = tab.dataset.page;
    navigateTo(page);
    vibrate();
  });
});

function navigateTo(page) {
  $$('.tab-item').forEach((t) => t.classList.toggle('active', t.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));

  const loaders = {
    home: loadHome, records: loadRecords, search: () => {},
    shifts: loadShifts, more: loadMore,
  };
  loaders[page]?.();
}

function activePageId() {
  return document.querySelector('.page.active')?.id || '';
}

// --- Live desk (WebSocket) ---
let liveSocket = null;
let liveReconnectTimer = null;
let liveRefreshTimer = null;
const livePending = new Set();

function disconnectLive() {
  if (liveReconnectTimer) {
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = null;
  }
  if (liveRefreshTimer) {
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = null;
  }
  livePending.clear();
  if (liveSocket) {
    try {
      liveSocket.onopen = null;
      liveSocket.onmessage = null;
      liveSocket.onclose = null;
      liveSocket.onerror = null;
      liveSocket.close();
    } catch { /* ignore */ }
    liveSocket = null;
  }
}

function scheduleLiveRefresh(kinds) {
  for (const k of kinds) livePending.add(k);
  if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(async () => {
    liveRefreshTimer = null;
    const pending = [...livePending];
    livePending.clear();
    const page = activePageId();
    try {
      if (pending.includes('shift') || pending.includes('records')) {
        await loadHome();
        if (page === 'page-records') await loadRecords();
      }
      if (pending.includes('shifts') && page === 'page-shifts') {
        await loadShifts(false);
      }
    } catch {
      /* silent — next event or nav will retry */
    }
  }, 250);
}

function connectLive() {
  disconnectLive();
  if (!API.token || !state.user) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/live?token=${encodeURIComponent(API.token)}`;
  let socket;
  try {
    socket = new WebSocket(url);
  } catch {
    liveReconnectTimer = setTimeout(connectLive, 4000);
    return;
  }
  liveSocket = socket;

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg?.type || msg.type === 'hello') return;
    if (msg.type === 'shift') scheduleLiveRefresh(['shift', 'records']);
    else if (msg.type === 'records') scheduleLiveRefresh(['records', 'shift']);
    else if (msg.type === 'shifts') scheduleLiveRefresh(['shifts', 'shift']);
  };

  socket.onclose = () => {
    if (liveSocket !== socket) return;
    liveSocket = null;
    if (!API.token || !state.user) return;
    liveReconnectTimer = setTimeout(connectLive, 3000);
  };

  socket.onerror = () => {
    try { socket.close(); } catch { /* ignore */ }
  };
}

// --- Home ---
async function loadHome() {
  try {
    const data = await API.getActiveShift();
    state.shift = data.shift;
    state.stats = data.stats;
    state.shiftUserName = data.user_name || data.shift?.user_name || null;
    renderShiftBanner();
    renderStats();
    renderQuickActions();
    if (state.shift) await loadRecentActivity();
    else $('#recent-activity').innerHTML = '';
  } catch (err) {
    toast(err.message, true);
  }
}

function renderShiftBanner() {
  const el = $('#shift-banner');
  if (state.shift) {
    const duration = getShiftDuration(state.shift.started_at);
    const opener = state.shiftUserName || state.shift.user_name || '';
    const closeBtn = canCloseActiveShift()
      ? `<button class="btn btn-sm btn-danger" onclick="window.closeShiftPrompt()">Close</button>`
      : '';
    el.innerHTML = `
      <div class="shift-banner open">
        <div class="shift-dot"></div>
        <div style="flex:1">
          <div style="font-weight:600;font-size:15px">Shift Open${opener ? ` — ${esc(opener)}` : ''}</div>
          <div class="text-sm text-secondary">since ${formatTime(state.shift.started_at)} · ${duration}</div>
        </div>
        ${closeBtn}
      </div>`;
  } else if (hasPerm('shift.open')) {
    el.innerHTML = `
      <div class="shift-banner closed">
        <div style="flex:1">
          <div style="font-weight:600;font-size:15px">Shift Closed</div>
          <div class="text-sm text-secondary">Start a new shift</div>
        </div>
        <button class="btn btn-sm btn-success" onclick="window.openShiftPrompt()">Start</button>
      </div>`;
  } else {
    el.innerHTML = '';
  }
}

function getShiftDuration(started) {
  const ms = Date.now() - new Date(started).getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function renderStats() {
  const el = $('#stats-grid');
  if (!state.shift || !state.stats) {
    el.innerHTML = '';
    return;
  }
  const s = state.stats;
  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-label">Income</div>
      <div class="stat-value income">${formatMoney(s.income_total)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Expense</div>
      <div class="stat-value expense">${formatMoney(s.expense_total)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Net</div>
      <div class="stat-value" style="color:${s.net >= 0 ? 'var(--green)' : 'var(--red)'}">${formatMoney(s.net)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Entries</div>
      <div class="stat-value" style="font-size:16px;line-height:1.4;margin-top:6px">
        <span title="Unpaid agency">${s.agency_count} unpaid</span><br>
        <span title="Pay-at-door agency">${s.agency_pay_at_door_count || 0} pay at door</span><br>
        <span title="Walk-in">${s.walk_in_count || 0} walk-in</span>
      </div>
    </div>`;
}

function renderQuickActions() {
  const disabled = !state.shift;
  const actions = [
    hasPerm('income.create') && `<div class="quick-action" onclick="window.showIncomeForm()" style="opacity:${disabled ? 0.4 : 1}">
      <div class="quick-action-icon" style="background:#E8F8EE">${icon('income', { size: 24, color: '#34C759' })}</div>
      <span class="quick-action-label">Add Income</span>
    </div>`,
    hasPerm('expense.create') && `<div class="quick-action" onclick="window.showExpenseForm()" style="opacity:${disabled ? 0.4 : 1}">
      <div class="quick-action-icon" style="background:#FFE8E8">${icon('expense', { size: 24, color: '#FF3B30' })}</div>
      <span class="quick-action-label">Add Expense</span>
    </div>`,
    hasPerm('guest_entry.create') && `<div class="quick-action" onclick="window.showGuestEntryForm()" style="opacity:${disabled ? 0.4 : 1}">
      <div class="quick-action-icon" style="background:#FFF3E0">${icon('guest-entry', { size: 24, color: '#FF9500' })}</div>
      <span class="quick-action-label">Guest Entry</span>
    </div>`,
  ].filter(Boolean);

  $('#quick-actions').innerHTML = actions.length
    ? actions.join('')
    : '<p class="text-secondary text-sm text-center" style="grid-column:1/-1">You do not have permission to add records</p>';
}

async function loadRecentActivity() {
  if (!state.shift) return;
  try {
    const data = await API.getShift(state.shift.id);
    const items = [
      ...data.transactions.map((t) => ({ ...t, kind: 'transaction' })),
      ...data.expenses.map((e) => ({ ...e, kind: 'expense' })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8);

    if (items.length === 0) {
      $('#recent-activity').innerHTML = `
        ${emptyState('clipboard', 'No records yet', 'Start by adding income or expenses')}`;
      return;
    }

    $('#recent-activity').innerHTML = `
      <div class="list-group-title">Recent Activity</div>
      <div class="list-group">${items.map(renderActivityItem).join('')}</div>`;
  } catch {
    // silent
  }
}

function txIconName(t) {
  if (t.type === 'walk_in') return 'walk';
  if (t.type === 'agency') return (t.amount || 0) > 0 ? 'credit-card' : 'building';
  return 'income';
}

function txIconColor(t) {
  if (t.type === 'walk_in') return '#007AFF';
  if (t.type === 'agency') return (t.amount || 0) > 0 ? '#007AFF' : '#FF9500';
  return '#34C759';
}

function txIconHtml(t, size = 18) {
  return icon(txIconName(t), { size, color: txIconColor(t) });
}

function txIconBg(t) {
  if (t.type === 'walk_in') return '#E8F2FF';
  if (t.type === 'agency') return (t.amount || 0) > 0 ? '#E8F2FF' : '#FFF3E0';
  return '#E8F8EE';
}

function txValue(t) {
  if (t.type === 'agency' && !(t.amount > 0)) return 'Entry';
  if (t.type === 'walk_in' || t.amount > 0) return formatMoney(t.amount);
  return formatMoney(t.amount);
}

function renderActivityItem(item) {
  const creator = recordCreatorLabel(item);
  if (item.kind === 'expense') {
    const cat = CATEGORIES[item.category] || CATEGORIES.diger;
    return `
      <div class="list-item">
        <div class="list-item-icon" style="background:#FFE8E8">${icon(cat.icon, { size: 18, color: cat.color })}</div>
        <div class="list-item-body">
          <div class="list-item-title">${esc(item.description)}</div>
          <div class="list-item-subtitle">${creator ? `${esc(creator)} · ` : ''}${cat.label} · ${formatTime(item.created_at)}</div>
        </div>
        <div class="list-item-value" style="color:var(--red)">-${formatMoney(item.amount)}</div>
      </div>`;
  }

  const subtitle = getTransactionSubtitle(item);
  return `
    <div class="list-item">
      <div class="list-item-icon" style="background:${txIconBg(item)}">${txIconHtml(item)}</div>
      <div class="list-item-body">
        <div class="list-item-title">${esc(getTransactionTitle(item))}</div>
        <div class="list-item-subtitle">${creator ? `${esc(creator)} · ` : ''}${subtitle ? `${esc(subtitle)} · ` : ''}${formatTime(item.created_at)}</div>
      </div>
      <div class="list-item-value" style="color:var(--green)">${txValue(item)}</div>
    </div>`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// --- Shift Open/Close ---
window.openShiftPrompt = () => {
  if (!hasPerm('shift.open')) return toast('You do not have permission', true);
  openSheet('Start Shift', `
    <div class="form-group">
      <label class="form-label">Opening Cash (₺)</label>
      <input type="number" id="f-opening-cash" step="0.01" min="0" value="0" placeholder="0.00">
    </div>`, async () => {
    const cash = parseFloat($('#f-opening-cash').value) || 0;
    await API.openShift(cash);
    vibrate(20);
    toast('Shift started!');
    loadHome();
  });
};

window.closeShiftPrompt = () => {
  if (!canCloseActiveShift()) {
    return toast(
      hasPerm('shift.close')
        ? 'Only the person who opened the shift can close it'
        : 'You do not have permission',
      true
    );
  }
  if (!state.shift) return;
  openSheet('Close Shift', `
    <div class="form-group">
      <label class="form-label">Closing Cash (₺)</label>
      <input type="number" id="f-closing-cash" step="0.01" min="0" placeholder="0.00">
    </div>
    <div class="form-group">
      <label class="form-label">Closing Note</label>
      <textarea id="f-closing-notes" placeholder="Shift notes, special situations..."></textarea>
    </div>
    ${state.stats ? `
    <div class="card" style="background:var(--bg)">
      <div class="detail-row"><span class="detail-label">Total Income</span><span style="color:var(--green);font-weight:600">${formatMoney(state.stats.income_total)}</span></div>
      <div class="detail-row"><span class="detail-label">Total Expense</span><span style="color:var(--red);font-weight:600">${formatMoney(state.stats.expense_total)}</span></div>
      <div class="detail-row"><span class="detail-label">Net</span><span style="font-weight:700">${formatMoney(state.stats.net)}</span></div>
      <div class="detail-row"><span class="detail-label">Unpaid agency</span><span>${state.stats.agency_count}</span></div>
      <div class="detail-row"><span class="detail-label">Pay-at-door agency</span><span>${state.stats.agency_pay_at_door_count || 0}</span></div>
      <div class="detail-row"><span class="detail-label">Walk-in</span><span>${state.stats.walk_in_count || 0}</span></div>
    </div>` : ''}`, async () => {
    const closing_cash = parseFloat($('#f-closing-cash').value) || undefined;
    const closing_notes = $('#f-closing-notes').value.trim() || undefined;
    await API.closeShift(state.shift.id, { closing_cash, closing_notes });
    vibrate(20);
    toast('Shift closed');
    state.shift = null;
    loadHome();
  });
};

// --- Forms ---
window.showIncomeForm = () => {
  if (!hasPerm('income.create')) return toast('You do not have permission', true);
  if (!state.shift) return toast('Start a shift first', true);
  openSheet('Add Income', incomeFormHTML(), saveIncome);
};

window.showExpenseForm = () => {
  if (!hasPerm('expense.create')) return toast('You do not have permission', true);
  if (!state.shift) return toast('Start a shift first', true);
  openSheet('Add Expense', expenseFormHTML(), saveExpense);
};

window.showGuestEntryForm = () => {
  if (!hasPerm('guest_entry.create')) return toast('You do not have permission', true);
  if (!state.shift) return toast('Start a shift first', true);
  state.entryMode = 'agency_no_payment';
  openSheet('Guest Entry', guestEntryFormHTML(), saveGuestEntry);
  setupGuestEntryHandlers();
};

function guestEntryFormHTML() {
  const entryPills = Object.entries(ENTRY_TYPES).map(([k, v]) =>
    `<div class="search-tab entry-type-tab${state.entryMode === k ? ' active' : ''}" data-entry="${k}">${icon(v.icon, { size: 14 })}<span>${v.shortLabel}</span></div>`
  ).join('');

  return `
    <div class="search-tabs" id="f-entry-type">${entryPills}</div>
    <div id="f-entry-fields">${guestEntryFieldsHTML(state.entryMode)}</div>`;
}

function guestEntryFieldsHTML(mode) {
  const cfg = ENTRY_TYPES[mode];
  const agencies = ALL_AGENCIES.map((a) =>
    `<div class="agency-pill" data-value="${a}">${a}</div>`
  ).join('');

  let html = '';

  if (cfg.requiresAgency) {
    html += `
      <div class="form-group">
        <label class="form-label">Agency</label>
        <div class="agency-pills" id="f-agency">${agencies}</div>
        <input type="text" id="f-agency-custom" class="mt-8 hidden" placeholder="Enter agency name...">
      </div>`;
  }

  html += `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Room No.</label>
        <input type="text" id="f-room" placeholder="101">
      </div>
      <div class="form-group">
        <label class="form-label">Guest First Name</label>
        <input type="text" id="f-guest-name" placeholder="First name">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Guest Last Name</label>
      <input type="text" id="f-guest-surname" placeholder="Last name">
    </div>`;

  if (cfg.requiresPayment) {
    html += `
      <div class="form-group">
        <label class="form-label">Amount (₺)</label>
        <input type="number" id="f-amount" step="0.01" min="0" placeholder="0.00" required>
      </div>
      <div class="form-group">
        <label class="form-label">Payment Method</label>
        <div class="payment-pills" id="f-payment">
          ${paymentPill('cash', 'cash', 'Cash', true)}
          ${paymentPill('credit_card', 'credit-card', 'Credit Card')}
          ${paymentPill('transfer', 'transfer', 'Transfer')}
        </div>
      </div>`;
  }

  html += `
    <div class="form-group">
      <label class="form-label">Not</label>
      <textarea id="f-notes" placeholder="Reservation details..."></textarea>
    </div>`;

  return html;
}

function setupGuestEntryHandlers() {
  $('#f-entry-type')?.querySelectorAll('.entry-type-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.entryMode = tab.dataset.entry;
      $('#f-entry-fields').innerHTML = guestEntryFieldsHTML(state.entryMode);
      $('#f-entry-type').querySelectorAll('.entry-type-tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.entry === state.entryMode);
      });
      setupPillHandlers($('#sheet-body'));
      vibrate();
    });
  });
  setupPillHandlers($('#sheet-body'));
}

async function saveGuestEntry() {
  const cfg = ENTRY_TYPES[state.entryMode];
  const payload = {
    shift_id: state.shift.id,
    type: cfg.type,
    room_number: $('#f-room').value.trim(),
    guest_name: $('#f-guest-name').value.trim(),
    guest_surname: $('#f-guest-surname').value.trim(),
    notes: $('#f-notes').value.trim(),
  };

  if (cfg.requiresAgency) {
    let agency = getSelectedPill('f-agency');
    if (agency === 'Other') agency = $('#f-agency-custom').value.trim();
    if (!agency) throw new Error('Select an agency');
    payload.agency_name = agency;
  }

  if (cfg.requiresPayment) {
    const amount = parseFloat($('#f-amount').value);
    if (!amount || amount <= 0) throw new Error('Enter a valid amount');
    payload.amount = amount;
    payload.payment_method = getSelectedPill('f-payment') || 'cash';
  }

  await API.createTransaction(payload);
  vibrate(20);
  toast('Guest entry saved!');
  loadHome();
}

// Alias for older callers
window.showAgencyForm = window.showGuestEntryForm;

function incomeFormHTML(data = {}) {
  return `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Room No.</label>
        <input type="text" id="f-room" value="${esc(data.room_number || '')}" placeholder="101">
      </div>
      <div class="form-group">
        <label class="form-label">Amount (₺)</label>
        <input type="number" id="f-amount" step="0.01" min="0" value="${data.amount || ''}" placeholder="0.00" required>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Guest First Name</label>
        <input type="text" id="f-guest-name" value="${esc(data.guest_name || '')}" placeholder="First name">
      </div>
      <div class="form-group">
        <label class="form-label">Guest Last Name</label>
        <input type="text" id="f-guest-surname" value="${esc(data.guest_surname || '')}" placeholder="Last name">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Payment Method</label>
      <div class="payment-pills" id="f-payment">
        ${paymentPill('cash', 'cash', 'Cash', true)}
        ${paymentPill('credit_card', 'credit-card', 'Credit Card')}
        ${paymentPill('transfer', 'transfer', 'Transfer')}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input type="text" id="f-desc" value="${esc(data.description || '')}" placeholder="Extra stay, minibar, etc.">
    </div>
    <div class="form-group">
      <label class="form-label">Not</label>
      <textarea id="f-notes" placeholder="Additional notes...">${esc(data.notes || '')}</textarea>
    </div>`;
}

function expenseFormHTML(data = {}) {
  const cats = Object.entries(CATEGORIES).map(([k, v]) =>
    `<div class="category-item${data.category === k ? ' active' : ''}" data-value="${k}">
      <span class="cat-icon">${icon(v.icon, { size: 20, color: v.color })}</span>${v.label}
    </div>`
  ).join('');

  return `
    <div class="form-group">
      <label class="form-label">Category</label>
      <div class="category-grid" id="f-category">${cats}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Description</label>
      <input type="text" id="f-desc" value="${esc(data.description || '')}" placeholder="Morning breakfast supplies" required>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Amount (₺)</label>
        <input type="number" id="f-amount" step="0.01" min="0" value="${data.amount || ''}" placeholder="0.00" required>
      </div>
      <div class="form-group">
        <label class="form-label">Vendor</label>
        <input type="text" id="f-vendor" value="${esc(data.vendor || '')}" placeholder="Migros, etc.">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Payment Method</label>
      <div class="payment-pills" id="f-payment">
        ${paymentPill('cash', 'cash', 'Cash', true)}
        ${paymentPill('credit_card', 'credit-card', 'Credit Card')}
        ${paymentPill('transfer', 'transfer', 'Transfer')}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Not</label>
      <textarea id="f-notes" placeholder="Additional notes...">${esc(data.notes || '')}</textarea>
    </div>`;
}

function setupPillHandlers(container) {
  container?.querySelectorAll('.payment-pill, .agency-pill, .category-item').forEach((pill) => {
    pill.addEventListener('click', () => {
      const parent = pill.parentElement;
      parent.querySelectorAll('.payment-pill, .agency-pill, .category-item').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      vibrate();

      if (pill.dataset.value === 'Other' && parent.id === 'f-agency') {
        $('#f-agency-custom').classList.remove('hidden');
      } else if (parent.id === 'f-agency') {
        $('#f-agency-custom').classList.add('hidden');
      }
    });
  });
}

function getSelectedPill(id) {
  return $(`#${id} .active`)?.dataset.value;
}

async function saveIncome() {
  const amount = parseFloat($('#f-amount').value);
  if (!amount || amount <= 0) throw new Error('Enter a valid amount');

  await API.createTransaction({
    shift_id: state.shift.id,
    type: 'income',
    room_number: $('#f-room').value.trim(),
    guest_name: $('#f-guest-name').value.trim(),
    guest_surname: $('#f-guest-surname').value.trim(),
    amount,
    payment_method: getSelectedPill('f-payment') || 'cash',
    description: $('#f-desc').value.trim(),
    notes: $('#f-notes').value.trim(),
  });
  vibrate(20);
  toast('Income saved!');
  loadHome();
}

async function saveExpense() {
  const amount = parseFloat($('#f-amount').value);
  if (!amount || amount <= 0) throw new Error('Enter a valid amount');
  if (!$('#f-desc').value.trim()) throw new Error('Description is required');

  await API.createExpense({
    shift_id: state.shift.id,
    category: getSelectedPill('f-category') || 'diger',
    description: $('#f-desc').value.trim(),
    amount,
    payment_method: getSelectedPill('f-payment') || 'cash',
    vendor: $('#f-vendor').value.trim(),
    notes: $('#f-notes').value.trim(),
  });
  vibrate(20);
  toast('Expense saved!');
  loadHome();
}

// --- Sheet ---
function openSheet(title, html, onSave, { saveLabel = 'Save', closeOnSave = true } = {}) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = html;
  state.sheetCallback = onSave;
  state.sheetCloseOnSave = closeOnSave;
  setupPillHandlers($('#sheet-body'));
  const saveBtn = $('#sheet-save');
  if (saveBtn) {
    saveBtn.style.display = onSave ? '' : 'none';
    saveBtn.textContent = saveLabel;
    saveBtn.disabled = false;
  }
  $('#sheet-overlay').classList.add('open');
  lockBodyScroll();
}

function closeSheet() {
  if (!$('#sheet-overlay')?.classList.contains('open')) return;
  $('#sheet-overlay').classList.remove('open');
  unlockBodyScroll();
  state.sheetCallback = null;
  state.sheetCloseOnSave = true;
  state.editSession = null;
  const cancelBtn = $('#sheet-cancel');
  if (cancelBtn) cancelBtn.textContent = 'Cancel';
}

$('#sheet-cancel').addEventListener('click', () => {
  if (state.editSession && state.editSession.step > 0) {
    collectEditStepFields();
    state.editSession.step -= 1;
    openEditWizard();
    return;
  }
  state.editSession = null;
  closeSheet();
});
$('#sheet-overlay').addEventListener('click', (e) => {
  if (e.target === $('#sheet-overlay')) closeSheet();
});

$('#sheet-save').addEventListener('click', async () => {
  if (!state.sheetCallback) return;
  try {
    $('#sheet-save').disabled = true;
    // Capture before callback: advancing to the last edit step sets closeOnSave=true
    // for the new "Save" button, which must not close the sheet on this click.
    const shouldClose = state.sheetCloseOnSave !== false;
    await state.sheetCallback();
    if (shouldClose) closeSheet();
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('#sheet-save').disabled = false;
  }
});

// --- Records ---
function indexShiftRecords(transactions = [], expenses = []) {
  state.recordIndex = { transactions: {}, expenses: {} };
  for (const t of transactions) state.recordIndex.transactions[t.id] = t;
  for (const e of expenses) state.recordIndex.expenses[e.id] = e;
}

async function loadRecords() {
  if (!state.shift) {
    $('#records-content').innerHTML = emptyState('clipboard', 'No active shift', 'Start a shift to see records');
    return;
  }

  try {
    const data = await API.getShift(state.shift.id);
    const txs = data.transactions || [];
    const exps = data.expenses || [];
    indexShiftRecords(txs, exps);

    $('#records-content').innerHTML = `
      <div class="flex-between mb-8">
        <span class="text-sm text-secondary">Active shift records</span>
        <span class="text-sm text-secondary">${txs.length + exps.length} records</span>
      </div>
      ${txs.length ? `
        <div class="list-group-title">Income & Entries (${txs.length})</div>
        <div class="list-group">${txs.map(renderRecordTx).join('')}</div>` : ''}
      ${exps.length ? `
        <div class="list-group-title">Expenses (${exps.length})</div>
        <div class="list-group">${exps.map(renderRecordExp).join('')}</div>` : ''}
      ${!txs.length && !exps.length ? emptyState('clipboard', 'No records yet') : ''}`;
  } catch (err) {
    toast(err.message, true);
  }
}

function renderRecordTx(t) {
  const badge = PAYMENT_BADGE[t.payment_method] || '';
  const showBadge = t.payment_method && t.payment_method !== 'none';
  const creator = recordCreatorLabel(t);
  const subtitle = getTransactionSubtitle(t);
  return `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title title-with-icon">${txIconHtml(t, 16)}<span>${esc(getTransactionTitle(t))}${t.amount > 0 ? ` — ${formatMoney(t.amount)}` : ''}</span></div>
        <div class="list-item-subtitle">
          ${creator ? `<span>${esc(creator)}</span>` : ''}
          ${subtitle ? `${creator ? ' · ' : ''}${esc(subtitle)}` : ''}
          ${showBadge ? `<span class="badge ${badge}">${PAYMENT_LABELS[t.payment_method]}</span>` : ''}
          · ${formatDate(t.created_at)}
        </div>
        ${t.notes ? `<div class="note-line text-sm text-secondary mt-8">${noteIcon()}<span>${esc(t.notes)}</span></div>` : ''}
      </div>
      ${recordActionButtons('transaction', t)}
    </div>`;
}

function renderRecordExp(e) {
  const cat = CATEGORIES[e.category] || CATEGORIES.diger;
  const badge = PAYMENT_BADGE[e.payment_method] || '';
  const creator = recordCreatorLabel(e);
  return `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title title-with-icon">${icon(cat.icon, { size: 16, color: cat.color })}<span>${esc(e.description)} — ${formatMoney(e.amount)}</span></div>
        <div class="list-item-subtitle">
          ${creator ? `<span>${esc(creator)}</span>` : ''}
          ${creator ? ' · ' : ''}${cat.label}
          <span class="badge ${badge}">${PAYMENT_LABELS[e.payment_method]}</span>
          ${e.vendor ? `· ${esc(e.vendor)}` : ''}
          · ${formatDate(e.created_at)}
        </div>
        ${e.notes ? `<div class="note-line text-sm text-secondary mt-8">${noteIcon()}<span>${esc(e.notes)}</span></div>` : ''}
      </div>
      ${recordActionButtons('expense', e)}
    </div>`;
}

window.deleteRecord = async (type, id) => {
  if (!hasPerm('record.delete')) return toast('You do not have permission', true);
  const record = state.recordIndex[type === 'transaction' ? 'transactions' : 'expenses']?.[id];
  if (record && !canMutateRecord(record)) {
    return toast('You can only delete your own records', true);
  }
  const ok = await showConfirm({
    title: 'Delete Record',
    message: 'Are you sure you want to delete this record?',
    confirmText: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    if (type === 'transaction') await API.deleteTransaction(id);
    else await API.deleteExpense(id);
    vibrate(20);
    toast('Record deleted');
    if ($('#sheet-overlay')?.classList.contains('open') && state.editSession) closeSheet();
    loadRecords();
    loadHome();
  } catch (err) {
    toast(err.message, true);
  }
};

window.editRecord = (type, id) => {
  if (!hasPerm('record.edit')) return toast('You do not have permission', true);
  const key = type === 'transaction' ? 'transactions' : 'expenses';
  const record = state.recordIndex[key]?.[id];
  if (!record) return toast('Record not found', true);
  if (!canMutateRecord(record)) return toast('You can only edit your own records', true);

  state.editSession = {
    type,
    id,
    step: 0,
    draft: { ...record },
  };
  openEditWizard();
};

const CHANGE_FIELD_LABELS = {
  room_number: 'Room',
  guest_name: 'Guest first name',
  guest_surname: 'Guest last name',
  amount: 'Amount',
  payment_method: 'Payment',
  agency_name: 'Agency',
  description: 'Description',
  notes: 'Note',
  created_at: 'Transaction date',
  category: 'Category',
  vendor: 'Vendor',
};

const CHANGE_ACTION_LABELS = {
  created: 'Record created',
  updated: 'Record updated',
  deleted: 'Record deleted',
};

function formatChangeValue(field, value) {
  if (value == null || value === '') return '—';
  if (field === 'amount') return formatMoney(Number(value) || 0);
  if (field === 'payment_method') return PAYMENT_LABELS[value] || value;
  if (field === 'category') return (CATEGORIES[value] || CATEGORIES.diger).label;
  if (field === 'created_at') return formatDate(value);
  return String(value);
}

function renderChangeTimeline(items) {
  if (!items?.length) {
    return emptyState('clock', 'No history yet', 'No change history found for this record');
  }

  return `<div class="change-timeline">${items.map((item, idx) => {
    const isLast = idx === items.length - 1;
    const changesHtml = (item.changes || []).map((ch) => `
      <div class="change-row">
        <span class="change-field">${esc(CHANGE_FIELD_LABELS[ch.field] || ch.field)}</span>
        <span class="change-values">
          <span class="change-from">${esc(formatChangeValue(ch.field, ch.from))}</span>
          <span class="change-arrow">→</span>
          <span class="change-to">${esc(formatChangeValue(ch.field, ch.to))}</span>
        </span>
      </div>`).join('');

    return `
      <div class="change-timeline-item${isLast ? ' is-last' : ''}">
        <div class="change-timeline-rail" aria-hidden="true">
          <div class="change-timeline-dot"></div>
          ${isLast ? '' : '<div class="change-timeline-pipe"></div>'}
        </div>
        <div class="change-timeline-body">
          <div class="change-timeline-title">${esc(CHANGE_ACTION_LABELS[item.action] || item.action)}</div>
          <div class="change-timeline-meta">
            ${formatDate(item.created_at)}
            ${item.user_name ? ` · ${esc(item.user_name)}` : ''}
          </div>
          ${changesHtml ? `<div class="change-list">${changesHtml}</div>` : ''}
        </div>
      </div>`;
  }).join('')}</div>`;
}

window.showRecordLog = async (type, id) => {
  openSheet('Record History', '<div class="spinner" style="margin:40px auto"></div>', null);
  try {
    const data = type === 'transaction'
      ? await API.getTransactionHistory(id)
      : await API.getExpenseHistory(id);
    if (!$('#sheet-overlay')?.classList.contains('open')) return;
    $('#sheet-body').innerHTML = renderChangeTimeline(data.items || []);
  } catch (err) {
    if ($('#sheet-overlay')?.classList.contains('open')) closeSheet();
    toast(err.message, true);
  }
};

function editStepLabels(type, draft) {
  if (type === 'expense') return ['Category', 'Amount & Payment', 'Date & Note'];
  if (draft.type === 'agency' && !(Number(draft.amount) > 0)) {
    return ['Guest & Agency', 'Details', 'Date & Note'];
  }
  return ['Guest & Room', 'Amount & Payment', 'Date & Note'];
}

function collectEditStepFields() {
  const session = state.editSession;
  if (!session) return;
  const d = session.draft;

  if (session.type === 'expense') {
    if (session.step === 0) {
      d.category = getSelectedPill('f-category') || d.category || 'diger';
      d.description = $('#f-desc')?.value.trim() || '';
    } else if (session.step === 1) {
      d.amount = parseFloat($('#f-amount')?.value) || 0;
      d.payment_method = getSelectedPill('f-payment') || d.payment_method || 'cash';
      d.vendor = $('#f-vendor')?.value.trim() || '';
    } else if (session.step === 2) {
      const iso = fromDateTimeLocalValue($('#f-created-at')?.value);
      if (iso) d.created_at = iso;
      d.notes = $('#f-notes')?.value.trim() || '';
    }
    return;
  }

  if (session.step === 0) {
    d.room_number = $('#f-room')?.value.trim() || '';
    d.guest_name = $('#f-guest-name')?.value.trim() || '';
    d.guest_surname = $('#f-guest-surname')?.value.trim() || '';
    if (d.type === 'agency') {
      let agency = getSelectedPill('f-agency');
      if (agency === 'Other') agency = $('#f-agency-custom')?.value.trim() || '';
      if (agency) d.agency_name = agency;
    }
  } else if (session.step === 1) {
    if (d.type === 'agency' && !(Number(d.amount) > 0) && !$('#f-amount')) {
      d.description = $('#f-desc')?.value.trim() || '';
    } else {
      d.amount = parseFloat($('#f-amount')?.value) || 0;
      d.payment_method = getSelectedPill('f-payment') || d.payment_method || 'cash';
      d.description = $('#f-desc')?.value.trim() || d.description || '';
    }
  } else if (session.step === 2) {
    const iso = fromDateTimeLocalValue($('#f-created-at')?.value);
    if (iso) d.created_at = iso;
    d.notes = $('#f-notes')?.value.trim() || '';
  }
}

function validateEditStep() {
  const session = state.editSession;
  const d = session.draft;
  if (session.type === 'expense') {
    if (session.step === 0 && !d.description) throw new Error('Description is required');
    if (session.step === 1 && (!(d.amount > 0))) throw new Error('Enter a valid amount');
    return;
  }
  if (session.step === 0 && d.type === 'agency' && !d.agency_name) {
    throw new Error('Select an agency');
  }
  if (session.step === 1) {
    const needsPayment = d.type !== 'agency' || Number(d.amount) > 0 || $('#f-amount');
    if (needsPayment && d.type !== 'agency') {
      if (!(d.amount > 0)) throw new Error('Enter a valid amount');
    }
    if (d.type === 'walk_in' && !(d.amount > 0)) throw new Error('Enter a valid amount');
    if (d.type === 'income' && !(d.amount > 0)) throw new Error('Enter a valid amount');
    if (d.type === 'agency' && $('#f-amount') && !(d.amount > 0) && getSelectedPill('f-payment')) {
      // pay at door must have amount
      if (!(d.amount > 0)) throw new Error('Enter a valid amount');
    }
  }
  if (session.step === 2) {
    if (!$('#f-created-at')?.value || !fromDateTimeLocalValue($('#f-created-at').value)) {
      throw new Error('Enter a valid date');
    }
  }
}

function editWizardStepHTML() {
  const session = state.editSession;
  const d = session.draft;
  const labels = editStepLabels(session.type, d);
  let body = editStepsBar(session.step, labels);

  if (session.type === 'expense') {
    if (session.step === 0) {
      const cats = Object.entries(CATEGORIES).map(([k, v]) =>
        `<div class="category-item${(d.category || 'diger') === k ? ' active' : ''}" data-value="${k}">
          <span class="cat-icon">${icon(v.icon, { size: 20, color: v.color })}</span>${v.label}
        </div>`
      ).join('');
      body += `
        <div class="form-group">
          <label class="form-label">Category</label>
          <div class="category-grid" id="f-category">${cats}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" id="f-desc" value="${esc(d.description || '')}" placeholder="Description" required>
        </div>`;
    } else if (session.step === 1) {
      body += `
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Amount (₺)</label>
            <input type="number" id="f-amount" step="0.01" min="0" value="${d.amount || ''}" required>
          </div>
          <div class="form-group">
            <label class="form-label">Vendor</label>
            <input type="text" id="f-vendor" value="${esc(d.vendor || '')}" placeholder="Migros, etc.">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Payment Method</label>
          <div class="payment-pills" id="f-payment">${paymentPillsHTML(d.payment_method || 'cash')}</div>
        </div>`;
    } else {
      body += `
        <div class="form-group">
          <label class="form-label">Transaction Date</label>
          <input type="datetime-local" id="f-created-at" value="${toDateTimeLocalValue(d.created_at)}" required>
          <div class="text-sm text-secondary mt-8">If payment was made on another day, correct the date here.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Not</label>
          <textarea id="f-notes" placeholder="Additional notes...">${esc(d.notes || '')}</textarea>
        </div>`;
    }
    return body;
  }

  // transaction
  if (session.step === 0) {
    let agencyHtml = '';
    if (d.type === 'agency') {
      const agencies = ALL_AGENCIES.map((a) =>
        `<div class="agency-pill${d.agency_name === a ? ' active' : ''}" data-value="${a}">${a}</div>`
      ).join('');
      const custom = d.agency_name && !ALL_AGENCIES.includes(d.agency_name);
      agencyHtml = `
        <div class="form-group">
          <label class="form-label">Agency</label>
          <div class="agency-pills" id="f-agency">${agencies}</div>
          <input type="text" id="f-agency-custom" class="mt-8${custom ? '' : ' hidden'}"
            value="${esc(custom ? d.agency_name : '')}" placeholder="Enter agency name...">
        </div>`;
      if (custom) {
        // mark Other active visually after render via setup
      }
    }
    body += `
      ${agencyHtml}
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Room No.</label>
          <input type="text" id="f-room" value="${esc(d.room_number || '')}" placeholder="101">
        </div>
        <div class="form-group">
          <label class="form-label">Guest First Name</label>
          <input type="text" id="f-guest-name" value="${esc(d.guest_name || '')}" placeholder="First name">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Guest Last Name</label>
        <input type="text" id="f-guest-surname" value="${esc(d.guest_surname || '')}" placeholder="Last name">
      </div>`;
  } else if (session.step === 1) {
    const unpaidAgency = d.type === 'agency' && !(Number(d.amount) > 0);
    if (unpaidAgency) {
      body += `
        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" id="f-desc" value="${esc(d.description || '')}" placeholder="Optional">
        </div>
        <p class="text-sm text-secondary">This is an unpaid agency entry. No amount.</p>`;
    } else {
      body += `
        <div class="form-group">
          <label class="form-label">Amount (₺)</label>
          <input type="number" id="f-amount" step="0.01" min="0" value="${d.amount || ''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Payment Method</label>
          <div class="payment-pills" id="f-payment">${paymentPillsHTML(d.payment_method || 'cash')}</div>
        </div>
        ${d.type === 'income' ? `
        <div class="form-group">
          <label class="form-label">Description</label>
          <input type="text" id="f-desc" value="${esc(d.description || '')}" placeholder="Extra stay, minibar, etc.">
        </div>` : ''}`;
    }
  } else {
    body += `
      <div class="form-group">
        <label class="form-label">Transaction Date</label>
        <input type="datetime-local" id="f-created-at" value="${toDateTimeLocalValue(d.created_at)}" required>
        <div class="text-sm text-secondary mt-8">E.g. if payment was made on 07/02, correct the date here.</div>
      </div>
      <div class="form-group">
        <label class="form-label">Not</label>
        <textarea id="f-notes" placeholder="Additional notes...">${esc(d.notes || '')}</textarea>
      </div>`;
  }
  return body;
}

function openEditWizard() {
  const session = state.editSession;
  const labels = editStepLabels(session.type, session.draft);
  const isLast = session.step >= labels.length - 1;

  openSheet(
    'Edit Record',
    editWizardStepHTML(),
    async () => {
      collectEditStepFields();
      validateEditStep();
      if (session.step < labels.length - 1) {
        session.step += 1;
        openEditWizard();
        return;
      }
      await saveEditSession();
    },
    { saveLabel: isLast ? 'Save' : 'Next', closeOnSave: isLast }
  );

  // Keep sheet open between steps
  state.sheetCloseOnSave = isLast;
  setupPillHandlers($('#sheet-body'));

  // agency custom "Other" if name not in list
  if (session.type === 'transaction' && session.draft.type === 'agency' && session.step === 0) {
    const name = session.draft.agency_name;
    if (name && !ALL_AGENCIES.includes(name)) {
      const diger = $('#f-agency .agency-pill[data-value="Other"]');
      $('#f-agency')?.querySelectorAll('.agency-pill').forEach((p) => p.classList.remove('active'));
      diger?.classList.add('active');
      $('#f-agency-custom')?.classList.remove('hidden');
    }
  }

  const cancelBtn = $('#sheet-cancel');
  if (cancelBtn) cancelBtn.textContent = session.step > 0 ? 'Back' : 'Cancel';
}

async function saveEditSession() {
  const session = state.editSession;
  if (!session) return;
  const d = session.draft;

  if (session.type === 'expense') {
    await API.updateExpense(session.id, {
      category: d.category || 'diger',
      description: d.description,
      amount: d.amount,
      payment_method: d.payment_method || 'cash',
      vendor: d.vendor || null,
      notes: d.notes || null,
      created_at: d.created_at,
    });
  } else {
    const payload = {
      room_number: d.room_number || null,
      guest_name: d.guest_name || null,
      guest_surname: d.guest_surname || null,
      amount: d.amount ?? 0,
      payment_method: d.payment_method || 'none',
      agency_name: d.agency_name || null,
      description: d.description || null,
      notes: d.notes || null,
      created_at: d.created_at,
    };
    if (d.type === 'agency' && !(Number(d.amount) > 0)) {
      payload.amount = 0;
      payload.payment_method = 'none';
    }
    await API.updateTransaction(session.id, payload);
  }

  vibrate(20);
  toast('Record updated');
  state.editSession = null;
  const cancelBtn = $('#sheet-cancel');
  if (cancelBtn) cancelBtn.textContent = 'Cancel';
  loadRecords();
  loadHome();
}

// --- Search ---
const SEARCH_PAGE_SIZE = 20;
const SHIFTS_PAGE_SIZE = 20;
const AUDIT_PAGE_SIZE = 50;

const PERIOD_OPTIONS = [
  { value: 'all', label: 'All dates' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom range' },
];

const searchFilterState = { period: 'all', customFrom: '', customTo: '', offset: 0, hasMore: false, lastQuery: '' };
let shiftsPagination = { offset: 0, hasMore: false };
let shiftsFiltersReady = false;
const shiftsFilterState = { from: '', to: '' };
let auditPagination = { offset: 0, hasMore: false };

function istanbulDateStr(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' });
}

function getPeriodBounds(period, { customFrom, customTo } = {}) {
  if (!period || period === 'all') return {};
  const tz = '+03:00';
  const today = istanbulDateStr();

  if (period === 'custom') {
    if (!customFrom && !customTo) return {};
    const bounds = {};
    if (customFrom) bounds.from = `${customFrom}T00:00:00${tz}`;
    if (customTo) {
      const end = new Date(`${customTo}T12:00:00${tz}`);
      end.setDate(end.getDate() + 1);
      bounds.to = `${istanbulDateStr(end)}T00:00:00${tz}`;
    }
    return bounds;
  }

  if (period === 'today') {
    return { from: `${today}T00:00:00${tz}` };
  }

  const base = new Date(`${today}T12:00:00${tz}`);

  if (period === 'yesterday') {
    base.setDate(base.getDate() - 1);
    const yd = istanbulDateStr(base);
    return { from: `${yd}T00:00:00${tz}`, to: `${today}T00:00:00${tz}` };
  }

  if (period === '7d') {
    base.setDate(base.getDate() - 7);
    const from = istanbulDateStr(base);
    return { from: `${from}T00:00:00${tz}` };
  }

  if (period === '30d') {
    base.setDate(base.getDate() - 30);
    const from = istanbulDateStr(base);
    return { from: `${from}T00:00:00${tz}` };
  }

  return {};
}

function formatShortDate(isoDate) {
  if (!isoDate) return '';
  return new Date(`${isoDate}T12:00:00+03:00`).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Istanbul',
  });
}

function periodCustomDatesHTML(idPrefix) {
  return `
    <div class="period-custom-dates hidden" id="${idPrefix}-custom-dates">
      <div class="date-range-row">
        <div class="form-group">
          <label class="form-label">From</label>
          <input type="date" id="${idPrefix}-date-from">
        </div>
        <div class="form-group">
          <label class="form-label">To</label>
          <input type="date" id="${idPrefix}-date-to">
        </div>
      </div>
    </div>`;
}

function updatePeriodLabel(idPrefix, state) {
  const label = $(`#${idPrefix}-period-label`);
  if (!label) return;
  if (state.period === 'custom' && (state.customFrom || state.customTo)) {
    const from = state.customFrom ? formatShortDate(state.customFrom) : '…';
    const to = state.customTo ? formatShortDate(state.customTo) : '…';
    label.textContent = `${from} – ${to}`;
    return;
  }
  const opt = PERIOD_OPTIONS.find((o) => o.value === state.period);
  label.textContent = opt?.label || 'All dates';
}

function toggleCustomDates(idPrefix, show) {
  $(`#${idPrefix}-custom-dates`)?.classList.toggle('hidden', !show);
}

function setupPeriodFilter({ idPrefix, state, onChange }) {
  const fromEl = $(`#${idPrefix}-date-from`);
  const toEl = $(`#${idPrefix}-date-to`);
  if (fromEl) fromEl.value = state.customFrom || '';
  if (toEl) toEl.value = state.customTo || '';

  setupCustomPicker(`${idPrefix}-period`, PERIOD_OPTIONS, state.period, (value) => {
    state.period = value;
    if (value === 'custom' && !state.customFrom && !state.customTo) {
      const today = istanbulDateStr();
      state.customFrom = today;
      state.customTo = today;
      if (fromEl) fromEl.value = today;
      if (toEl) toEl.value = today;
    }
    toggleCustomDates(idPrefix, value === 'custom');
    updatePeriodLabel(idPrefix, state);
    if (value !== 'custom' || state.customFrom || state.customTo) onChange();
  });

  const applyCustom = () => {
    if (state.period !== 'custom') return;
    state.customFrom = fromEl?.value || '';
    state.customTo = toEl?.value || '';
    if (state.customFrom && state.customTo && state.customFrom > state.customTo) {
      [state.customFrom, state.customTo] = [state.customTo, state.customFrom];
      if (fromEl) fromEl.value = state.customFrom;
      if (toEl) toEl.value = state.customTo;
    }
    updatePeriodLabel(idPrefix, state);
    onChange();
  };

  fromEl?.addEventListener('change', applyCustom);
  toEl?.addEventListener('change', applyCustom);

  toggleCustomDates(idPrefix, state.period === 'custom');
  updatePeriodLabel(idPrefix, state);
}

function closeAllPickers() {
  $$('.picker-menu.open').forEach((m) => m.classList.remove('open'));
  $$('.picker-trigger.open').forEach((t) => t.classList.remove('open'));
}

function setupCustomPicker(id, options, currentValue, onSelect) {
  const trigger = $(`#${id}-trigger`);
  const menu = $(`#${id}-menu`);
  const label = $(`#${id}-label`);
  if (!trigger || !menu || !label) return;

  const selected = options.find((o) => o.value === currentValue) || options[0];
  label.textContent = selected.label;

  menu.innerHTML = options.map((o) => `
    <div class="picker-option${o.value === currentValue ? ' selected' : ''}" data-value="${o.value}">
      ${esc(o.label)}
    </div>`).join('');

  trigger.onclick = (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.contains('open');
    closeAllPickers();
    if (!isOpen) {
      menu.classList.add('open');
      trigger.classList.add('open');
    }
  };

  menu.querySelectorAll('.picker-option').forEach((opt) => {
    opt.onclick = (e) => {
      e.stopPropagation();
      const value = opt.dataset.value;
      const item = options.find((o) => o.value === value);
      if (item) {
        label.textContent = item.label;
        onSelect(value);
      }
      closeAllPickers();
    };
  });
}

function buildSearchQuery(q, offset = 0) {
  const params = new URLSearchParams({
    q,
    limit: String(SEARCH_PAGE_SIZE),
    offset: String(offset),
  });
  const bounds = getPeriodBounds(searchFilterState.period, searchFilterState);
  if (bounds.from) params.set('from', bounds.from);
  if (bounds.to) params.set('to', bounds.to);
  return params.toString();
}

function paginationFooter(hasMore, loadFn, shown, total) {
  if (!hasMore && !total) return '';
  const countText = total != null
    ? `<span class="pagination-count">${shown} / ${total} records</span>`
    : '';
  const btn = hasMore
    ? `<button type="button" class="btn-load-more" onclick="${loadFn}">Show more</button>`
    : '';
  return `<div class="pagination-bar">${countText}${btn}</div>`;
}

function setupSearchFilters() {
  const wrap = $('#search-custom-dates-wrap');
  if (wrap) wrap.innerHTML = periodCustomDatesHTML('search');
  setupPeriodFilter({
    idPrefix: 'search',
    state: searchFilterState,
    onChange: () => {
      searchFilterState.offset = 0;
      const q = $('#search-input').value.trim();
      const minLen = state.searchType === 'rooms' ? 1 : 2;
      if (q.length >= minLen) performSearch(q);
    },
  });
}

document.addEventListener('click', () => closeAllPickers());

let searchTimeout;
$('#search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  const q = e.target.value.trim();
  const minLen = state.searchType === 'rooms' ? 1 : 2;
  if (q.length < minLen) {
    $('#search-results').innerHTML = '';
    searchFilterState.offset = 0;
    searchFilterState.hasMore = false;
    return;
  }
  searchTimeout = setTimeout(() => performSearch(q), 300);
});

$$('.search-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.search-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.searchType = tab.dataset.type;
    searchFilterState.offset = 0;
    const q = $('#search-input').value.trim();
    const minLen = state.searchType === 'rooms' ? 1 : 2;
    if (q.length >= minLen) performSearch(q);
    else $('#search-results').innerHTML = '';
  });
});

window.loadMoreSearch = () => {
  const q = searchFilterState.lastQuery;
  if (!q) return;
  performSearch(q, true);
};

async function performSearch(q, append = false) {
  if (!append) {
    searchFilterState.offset = 0;
    $('#search-results').innerHTML = '<div class="spinner"></div>';
  } else {
    const btn = $('.btn-load-more');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }
  }

  searchFilterState.lastQuery = q;
  const offset = append ? searchFilterState.offset : 0;

  try {
    if (state.searchType === 'guests') {
      const data = await API.searchGuests(buildSearchQuery(q, offset));
      searchFilterState.offset = offset + data.results.length;
      searchFilterState.hasMore = data.pagination?.hasMore;
      renderGuestResults(data, q, append);
    } else if (state.searchType === 'rooms') {
      const data = await API.searchRooms(buildSearchQuery(q, offset));
      searchFilterState.offset = offset + data.results.length;
      searchFilterState.hasMore = data.pagination?.hasMore;
      renderSearchResults(data.results, append, data.pagination);
    } else {
      const data = await API.searchGlobal(buildSearchQuery(q, offset));
      searchFilterState.offset = offset + SEARCH_PAGE_SIZE;
      searchFilterState.hasMore = data.pagination?.hasMore;
      renderGlobalResults(data, append);
    }
  } catch (err) {
    if (!append) {
      $('#search-results').innerHTML = `<div class="empty-state"><div class="empty-state-text">${esc(err.message)}</div></div>`;
    } else {
      toast(err.message, true);
      const btn = $('.btn-load-more');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Show more';
      }
    }
  }
}

function renderGuestResults(data, q, append = false) {
  const { results, summary, pagination } = data;

  if (append) {
    $('#search-results .list-group')?.insertAdjacentHTML('beforeend', results.map((r) => renderSearchItem(r)).join(''));
    const footer = $('#search-results .pagination-bar');
    if (footer) {
      footer.outerHTML = paginationFooter(
        pagination?.hasMore,
        'window.loadMoreSearch()',
        searchFilterState.offset,
        pagination?.total,
      );
    }
    return;
  }

  let html = '';
  if (summary) {
    const roomsLabel = summary.rooms
      ? (Number(summary.room_count) > 1
        ? `${summary.room_count} rooms · ${summary.rooms}`
        : `Room ${summary.rooms}`)
      : '';
    html += `
      <div class="card mb-8">
        <div style="font-weight:600;margin-bottom:8px">"${esc(q)}" summary</div>
        <div class="detail-row"><span class="detail-label">Total Visits</span><span>${summary.total_visits}</span></div>
        <div class="detail-row"><span class="detail-label">Total Paid</span><span style="color:var(--green);font-weight:600">${formatMoney(summary.total_paid)}</span></div>
        ${roomsLabel ? `<div class="detail-row"><span class="detail-label">Rooms</span><span>${esc(roomsLabel)}</span></div>` : ''}
      </div>`;
  }

  if (!results.length) {
    html += emptyState('search', 'No results found');
  } else {
    html += `<div class="list-group">${results.map((r) => renderSearchItem(r)).join('')}</div>`;
  }

  html += paginationFooter(pagination?.hasMore, 'window.loadMoreSearch()', results.length, pagination?.total);
  $('#search-results').innerHTML = html;
}

function renderSearchResults(results, append = false, pagination = null) {
  if (!results.length && !append) {
    $('#search-results').innerHTML = emptyState('search', 'No results found');
    return;
  }

  if (append) {
    $('#search-results .list-group')?.insertAdjacentHTML('beforeend', results.map((r) => renderSearchItem(r)).join(''));
    const footer = $('#search-results .pagination-bar');
    if (footer) {
      footer.outerHTML = paginationFooter(
        pagination?.hasMore,
        'window.loadMoreSearch()',
        searchFilterState.offset,
        pagination?.total,
      );
    }
    return;
  }

  $('#search-results').innerHTML = `
    <div class="list-group">${results.map((r) => renderSearchItem(r)).join('')}</div>
    ${paginationFooter(pagination?.hasMore, 'window.loadMoreSearch()', results.length, pagination?.total)}`;
}

function renderGlobalResults(data, append = false) {
  const txs = data.transactions || [];
  const exps = data.expenses || [];
  const pagination = data.pagination || {};

  if (!txs.length && !exps.length && !append) {
    $('#search-results').innerHTML = emptyState('search', 'No results found');
    return;
  }

  if (append) {
    if (txs.length) {
      const txGroup = $('#search-results .list-group[data-type="transactions"]');
      if (txGroup) txGroup.insertAdjacentHTML('beforeend', txs.map((r) => renderSearchItem(r)).join(''));
    }
    if (exps.length) {
      const expGroup = $('#search-results .list-group[data-type="expenses"]');
      if (expGroup) {
        expGroup.insertAdjacentHTML('beforeend', exps.map((r) => `
          <div class="list-item">
            <div class="list-item-body">
              <div class="list-item-title title-with-icon">${icon('receipt', { size: 16, color: '#FF3B30' })}<span>${esc(r.description)} — ${formatMoney(r.amount)}</span></div>
              <div class="list-item-subtitle">${recordCreatorLabel(r) ? `${esc(recordCreatorLabel(r))} · ` : ''}${formatDate(r.created_at)}</div>
            </div>
          </div>`).join(''));
      }
    }
    const footer = $('#search-results .pagination-bar');
    if (footer) {
      const shown = searchFilterState.offset;
      const total = (pagination.transactionsTotal || 0) + (pagination.expensesTotal || 0);
      footer.outerHTML = paginationFooter(pagination.hasMore, 'window.loadMoreSearch()', shown, total);
    }
    return;
  }

  let html = '';
  if (txs.length) {
    html += `<div class="list-group-title">Income & Entries</div>
      <div class="list-group" data-type="transactions">${txs.map((r) => renderSearchItem(r)).join('')}</div>`;
  }
  if (exps.length) {
    html += `<div class="list-group-title">Expenses</div>
      <div class="list-group" data-type="expenses">${exps.map((r) => `
        <div class="list-item">
          <div class="list-item-body">
            <div class="list-item-title title-with-icon">${icon('receipt', { size: 16, color: '#FF3B30' })}<span>${esc(r.description)} — ${formatMoney(r.amount)}</span></div>
            <div class="list-item-subtitle">${recordCreatorLabel(r) ? `${esc(recordCreatorLabel(r))} · ` : ''}${formatDate(r.created_at)}</div>
          </div>
        </div>`).join('')}</div>`;
  }

  const total = (pagination.transactionsTotal || 0) + (pagination.expensesTotal || 0);
  const shown = txs.length + exps.length;
  html += paginationFooter(pagination.hasMore, 'window.loadMoreSearch()', shown, total);
  $('#search-results').innerHTML = html;
}

function renderSearchItem(r) {
  const amountPart = r.amount > 0 ? ` — ${formatMoney(r.amount)}` : '';
  const creator = recordCreatorLabel(r);
  const subtitle = getTransactionSubtitle(r);
  return `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title title-with-icon">${txIconHtml(r, 16)}<span>${esc(getTransactionTitle(r))}${amountPart}</span></div>
        <div class="list-item-subtitle">
          ${creator ? `<span>${esc(creator)}</span> · ` : ''}
          ${subtitle ? `${esc(subtitle)} · ` : ''}
          ${formatDate(r.created_at || r.shift_date)}
        </div>
        ${r.notes ? `<div class="note-line text-sm text-secondary mt-8">${noteIcon()}<span>${esc(r.notes)}</span></div>` : ''}
      </div>
    </div>`;
}

// --- Shifts History ---
function shiftsDateBounds() {
  const tz = '+03:00';
  const bounds = {};
  if (shiftsFilterState.from) {
    bounds.from = `${shiftsFilterState.from}T00:00:00${tz}`;
  }
  if (shiftsFilterState.to) {
    const end = new Date(`${shiftsFilterState.to}T12:00:00${tz}`);
    end.setDate(end.getDate() + 1);
    bounds.to = `${istanbulDateStr(end)}T00:00:00${tz}`;
  }
  return bounds;
}

function setupShiftsFilters() {
  if (shiftsFiltersReady) return;
  const today = istanbulDateStr();
  shiftsFilterState.from = today;
  shiftsFilterState.to = today;

  const fromEl = $('#shifts-date-from');
  const toEl = $('#shifts-date-to');
  if (fromEl) fromEl.value = today;
  if (toEl) toEl.value = today;

  const apply = () => {
    shiftsFilterState.from = fromEl?.value || '';
    shiftsFilterState.to = toEl?.value || '';
    if (shiftsFilterState.from && shiftsFilterState.to && shiftsFilterState.from > shiftsFilterState.to) {
      toast('From date cannot be after To date', true);
      return;
    }
    loadShifts(false);
  };

  fromEl?.addEventListener('change', apply);
  toEl?.addEventListener('change', apply);
  shiftsFiltersReady = true;
}

function renderShiftItem(s) {
  return `
    <div class="list-item" onclick="window.viewShift('${s.id}')">
      <div class="list-item-icon" style="background:${s.status === 'open' ? '#E8F8EE' : 'var(--bg)'}">${s.status === 'open' ? icon('circle-fill', { size: 14, color: '#34C759' }) : icon('stop', { size: 12, color: '#8E8E93' })}</div>
      <div class="list-item-body">
        <div class="list-item-title">${esc(s.user_name)}</div>
        <div class="list-item-subtitle">${formatDate(s.started_at)}${s.ended_at ? ` → ${formatTime(s.ended_at)}` : ''}</div>
      </div>
      <span class="list-item-chevron">›</span>
    </div>`;
}

window.loadMoreShifts = () => loadShifts(true);

async function loadShifts(append = false) {
  setupShiftsFilters();

  if (!append) {
    shiftsPagination = { offset: 0, hasMore: false };
    $('#shifts-list').innerHTML = '<div class="spinner"></div>';
  } else {
    const btn = $('#shifts-list .btn-load-more');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }
  }

  try {
    const bounds = shiftsDateBounds();
    const params = new URLSearchParams({
      limit: String(SHIFTS_PAGE_SIZE),
      offset: String(shiftsPagination.offset),
    });
    if (bounds.from) params.set('from', bounds.from);
    if (bounds.to) params.set('to', bounds.to);

    const data = await API.getShifts(params.toString());
    const items = data.items || [];
    const pagination = data.pagination || {};
    shiftsPagination.offset += items.length;
    shiftsPagination.hasMore = pagination.hasMore;

    if (!items.length && !append) {
      $('#shifts-list').innerHTML = emptyState('clock', 'No shifts in this date range');
      return;
    }

    const listHtml = items.map(renderShiftItem).join('');
    const footer = paginationFooter(pagination.hasMore, 'window.loadMoreShifts()', shiftsPagination.offset, pagination.total);

    if (append) {
      $('#shifts-list .shifts-items')?.insertAdjacentHTML('beforeend', listHtml);
      const bar = $('#shifts-list .pagination-bar');
      if (bar) bar.outerHTML = footer;
    } else {
      $('#shifts-list').innerHTML = `<div class="shifts-items">${listHtml}</div>${footer}`;
    }
  } catch (err) {
    if (!append) $('#shifts-list').innerHTML = '';
    toast(err.message, true);
  }
}

window.viewShift = async (id) => {
  openSheet('Shift Detail', '<div class="spinner" style="margin:40px auto"></div>', null);
  const sheetObserver = new MutationObserver(() => {
    if (!$('#sheet-overlay').classList.contains('open')) {
      sheetObserver.disconnect();
      $('#sheet-save').style.display = '';
      $('#sheet-save').textContent = 'Save';
    }
  });
  sheetObserver.observe($('#sheet-overlay'), { attributes: true, attributeFilter: ['class'] });

  try {
    const data = await API.getShift(id);
    if (!$('#sheet-overlay')?.classList.contains('open')) return;
    const s = data.stats;
    indexShiftRecords(data.transactions || [], data.expenses || []);
    $('#sheet-body').innerHTML = `
      <div class="detail-section">
        <div class="detail-row"><span class="detail-label">Staff</span><span>${esc(data.user_name)}</span></div>
        <div class="detail-row"><span class="detail-label">From</span><span>${formatDate(data.shift.started_at)}</span></div>
        <div class="detail-row"><span class="detail-label">To</span><span>${data.shift.ended_at ? formatDate(data.shift.ended_at) : 'In progress'}</span></div>
        <div class="detail-row"><span class="detail-label">Income</span><span style="color:var(--green);font-weight:600">${formatMoney(s.income_total)}</span></div>
        <div class="detail-row"><span class="detail-label">Expense</span><span style="color:var(--red);font-weight:600">${formatMoney(s.expense_total)}</span></div>
        <div class="detail-row"><span class="detail-label">Net</span><span style="font-weight:700">${formatMoney(s.net)}</span></div>
        <div class="detail-row"><span class="detail-label">Unpaid agency</span><span>${s.agency_count}</span></div>
        <div class="detail-row"><span class="detail-label">Pay-at-door agency</span><span>${s.agency_pay_at_door_count || 0}</span></div>
        <div class="detail-row"><span class="detail-label">Walk-in</span><span>${s.walk_in_count || 0}</span></div>
        ${data.shift.closing_notes ? `<div class="detail-row detail-row-stack"><span class="detail-label">Not</span><span class="detail-value-block">${esc(data.shift.closing_notes)}</span></div>` : ''}
      </div>
      <div class="list-group-title">Transactions (${data.transactions.length + data.expenses.length})</div>
      ${[...data.transactions.map((t) => renderRecordTx(t)), ...data.expenses.map((e) => renderRecordExp(e))].join('') || '<div class="text-secondary text-center" style="padding:16px">No records</div>'}`;

    state.sheetCloseOnSave = false;
    state.sheetCallback = async () => {
      const name = downloadShiftExcel(data);
      toast(`${name} downloaded`);
    };
    const saveBtn = $('#sheet-save');
    saveBtn.style.display = '';
    saveBtn.textContent = 'Excel';
    saveBtn.disabled = false;
  } catch (err) {
    if ($('#sheet-overlay')?.classList.contains('open')) closeSheet();
    toast(err.message, true);
  }
};

// --- More / Settings ---
async function loadMore() {
  const roleLabel = state.user.role === 'root' ? 'Administrator' : 'Staff';
  let html = `
    <div class="settings-section">
      <div class="list-group-title">Account</div>
      <div class="list-group">
        <div class="list-item">
          <div class="list-item-icon" style="background:var(--accent-light)">${icon('person', { size: 18, color: 'var(--accent)' })}</div>
          <div class="list-item-body">
            <div class="list-item-title">${esc(state.user.display_name)}</div>
            <div class="list-item-subtitle">@${esc(state.user.username)} · ${roleLabel}</div>
          </div>
          <span class="list-item-chevron is-spacer">›</span>
        </div>
      </div>
    </div>`;

  if (hasPerm('push.subscribe')) {
    const pushActive = await isPushActive();
    const pushIconBg = pushActive ? '#E8F8EE' : '#FFE8E8';
    const pushIconColor = pushActive ? 'var(--green)' : 'var(--red)';
    const pushSubtitle = pushActive ? 'Active' : 'Off';
    html += `
    <div class="settings-section">
      <div class="list-group-title">Notifications</div>
      <div class="list-group">
        <div class="list-item" onclick="window.togglePushNotifications()">
          <div class="list-item-icon" style="background:${pushIconBg}">${icon('bell', { size: 18, color: pushIconColor })}</div>
          <div class="list-item-body">
            <div class="list-item-title">Push Notifications</div>
            <div class="list-item-subtitle">${pushSubtitle}</div>
          </div>
          <span class="list-item-chevron">›</span>
        </div>
      </div>
    </div>`;
  }

  if (isRoot() || hasPerm('audit.view') || hasPerm('shift.view.all')) {
    html += `<div class="settings-section"><div class="list-group-title">Administration</div><div class="list-group">`;
    if (hasPerm('shift.view.all')) {
      html += `
        <div class="list-item" onclick="window.showMonthlyReports()">
          <div class="list-item-icon" style="background:#E8F8EE">${icon('receipt', { size: 18, color: '#34C759' })}</div>
          <div class="list-item-body">
            <div class="list-item-title">Monthly Reports</div>
            <div class="list-item-subtitle">Summary, details, and Excel</div>
          </div>
          <span class="list-item-chevron">›</span>
        </div>`;
    }
    if (isRoot()) {
      html += `
        <div class="list-item" onclick="window.showUsers()">
          <div class="list-item-icon" style="background:#E8F2FF">${icon('users', { size: 18, color: '#007AFF' })}</div>
          <div class="list-item-body">
            <div class="list-item-title">Users</div>
            <div class="list-item-subtitle">Users and permissions</div>
          </div>
          <span class="list-item-chevron">›</span>
        </div>`;
    }
    if (hasPerm('audit.view')) {
      html += `
        <div class="list-item" onclick="window.showAuditLogs()">
          <div class="list-item-icon" style="background:#F3E8FF">${icon('list-bullet', { size: 18, color: '#5856D6' })}</div>
          <div class="list-item-body">
            <div class="list-item-title">System Logs</div>
            <div class="list-item-subtitle">Transaction and activity logs</div>
          </div>
          <span class="list-item-chevron">›</span>
        </div>`;
    }
    html += `</div></div>`;
  }

  html += `
    <div class="list-group">
      <div class="list-item" onclick="window.logout()">
        <div class="list-item-icon" style="background:#FFE8E8">${icon('logout', { size: 18, color: '#FF3B30' })}</div>
        <div class="list-item-body">
          <div class="list-item-title" style="color:var(--red)">Sign out</div>
        </div>
      </div>
    </div>
    <div class="text-center text-secondary text-sm mt-16 app-version" id="app-version" onclick="window.onVersionTap()">Golden Gate v1.0</div>`;

  $('#more-content').innerHTML = html;
}

window.logout = () => {
  disconnectLive();
  API.setToken(null);
  state.user = null;
  state.shift = null;
  resetAppUiForSession();
  showLogin();
  toast('Signed out');
};

// --- Easter Egg ---
const EASTER_EGG_COVER_VERSION = 'v55';

const EASTER_EGG_PLAYLIST = [
  {
    id: 'dilerim-ki',
    title: 'Dilerim Ki',
    artist: 'Dolu Kadehi Ters Tut',
    src: '/easter-egg/dilerim-ki.m4a',
    cover: '/easter-egg/cover-dilerim.webp',
    sessionArtBase: 'dilerim',
    sessionArtSizes: [512, 256, 96],
  },
  {
    id: 'beni-al',
    title: 'Beni Al',
    artist: 'Ankara Echoes',
    src: '/easter-egg/beni-al.m4a',
    cover: '/easter-egg/cover-beni-al.webp',
    sessionArtBase: 'beni-al',
    sessionArtSizes: [512, 256, 96],
  },
  {
    id: 'kisa-mesafe',
    title: 'Kısa Mesafe',
    artist: 'Rafat Hasanlı',
    src: '/easter-egg/kisa-mesafe.m4a',
    cover: '/easter-egg/cover-kisa-mesafe.webp',
    sessionArtBase: 'kisa-mesafe',
    sessionArtSizes: [512, 256, 96],
  },
];

let versionTapCount = 0;
let versionTapTimer;
let easterEggTrackIndex = 0;

window.onVersionTap = () => {
  if (!hasPerm('easter_egg.access')) return;
  clearTimeout(versionTapTimer);
  versionTapCount += 1;
  versionTapTimer = setTimeout(() => { versionTapCount = 0; }, 2000);
  if (versionTapCount >= 6) {
    versionTapCount = 0;
    openEasterEgg();
  }
};

function formatAudioTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let easterEggScrubbing = false;
let easterEggScrubPointerId = null;
let easterEggQueueExpanded = false;
let easterEggQueueDragStartY = 0;
let easterEggQueueDragMoved = false;
let easterEggUnlockTimer;
let easterEggQueuePlaylistLocked = false;
let easterEggQueuePlaylistLockTimer;

function lockPlaylistInteractions(ms = 500) {
  easterEggQueuePlaylistLocked = true;
  const wrap = $('#easter-egg-playlist-wrap');
  wrap?.classList.remove('is-playlist-ready');
  wrap?.classList.add('is-interaction-locked');
  clearTimeout(easterEggQueuePlaylistLockTimer);
  easterEggQueuePlaylistLockTimer = setTimeout(() => {
    easterEggQueuePlaylistLocked = false;
    wrap?.classList.remove('is-interaction-locked');
    if (easterEggQueueExpanded) wrap?.classList.add('is-playlist-ready');
    easterEggQueuePlaylistLockTimer = null;
  }, ms);
}

function lockEasterEggInteractions() {
  const overlay = $('#easter-egg-overlay');
  if (!overlay) return;
  clearTimeout(easterEggUnlockTimer);
  overlay.classList.add('is-interaction-locked');
  easterEggUnlockTimer = setTimeout(() => {
    overlay.classList.remove('is-interaction-locked');
    easterEggUnlockTimer = null;
  }, 1000);
}

function getEasterEggPointerX(e, rail) {
  if (e.type.startsWith('touch')) {
    const t = e.touches?.[0] || e.changedTouches?.[0];
    return t?.clientX;
  }
  if (Number.isFinite(e.clientX)) return e.clientX;
  if (rail && Number.isFinite(e.offsetX)) {
    const rect = rail.getBoundingClientRect();
    return rect.left + e.offsetX;
  }
  return null;
}

function setEasterEggScrubber(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const fill = $('#easter-egg-scrubber-fill');
  const knob = $('#easter-egg-scrubber-knob');
  const scrubber = $('#easter-egg-scrubber');
  if (fill) fill.style.width = `${clamped}%`;
  if (knob) knob.style.left = `${clamped}%`;
  if (scrubber) scrubber.setAttribute('aria-valuenow', String(Math.round(clamped)));
}

function seekEasterEggTo(seconds) {
  const audio = $('#easter-egg-audio');
  if (!audio) return false;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return false;
  const target = Math.max(0, Math.min(audio.duration - 0.05, seconds));
  try {
    // Android Chrome needs Range-capable responses; SW bypass handles that.
    // Also avoid seeking into an empty seekable window.
    if (audio.seekable?.length) {
      const start = audio.seekable.start(0);
      const end = audio.seekable.end(audio.seekable.length - 1);
      audio.currentTime = Math.max(start, Math.min(end, target));
    } else {
      audio.currentTime = target;
    }
  } catch {
    try { audio.currentTime = target; } catch { return false; }
  }
  return true;
}

function seekEasterEggFromEvent(e) {
  const audio = $('#easter-egg-audio');
  const rail = $('#easter-egg-scrubber')?.querySelector('.easter-egg-scrubber-rail');
  if (!audio || !rail) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;

  const rect = rail.getBoundingClientRect();
  if (rect.width <= 0) return;

  const clientX = getEasterEggPointerX(e, rail);
  if (!Number.isFinite(clientX)) return;

  const pct = ((clientX - rect.left) / rect.width) * 100;
  const clamped = Math.max(0, Math.min(100, pct));
  seekEasterEggTo((clamped / 100) * audio.duration);
  setEasterEggScrubber(clamped);
  const timeCurrent = $('#easter-egg-time-current');
  if (timeCurrent) timeCurrent.textContent = formatAudioTime(audio.currentTime || 0);
}

function playPrevEasterEggTrack() {
  const prev = (easterEggTrackIndex - 1 + EASTER_EGG_PLAYLIST.length) % EASTER_EGG_PLAYLIST.length;
  loadEasterEggTrack(prev, true);
  vibrate(10);
}

function setEasterEggQueueExpanded(expanded) {
  easterEggQueueExpanded = expanded;
  const sheet = $('#easter-egg-queue-sheet');
  const handle = $('#easter-egg-queue-handle');
  const player = $('.easter-egg-player');
  const overlay = $('#easter-egg-overlay');
  const wrap = $('#easter-egg-playlist-wrap');
  if (!sheet) return;
  sheet.classList.toggle('is-expanded', expanded);
  player?.classList.toggle('is-queue-expanded', expanded);
  overlay?.classList.toggle('is-queue-expanded', expanded);
  wrap?.classList.remove('is-playlist-ready');
  if (wrap) {
    if (expanded) wrap.removeAttribute('inert');
    else wrap.setAttribute('inert', '');
  }
  if (handle) {
    handle.setAttribute('aria-expanded', String(expanded));
    handle.setAttribute('aria-label', expanded ? 'Hide playlist' : 'Show playlist');
  }
}

function setupEasterEggQueueSheet() {
  const handle = $('#easter-egg-queue-handle');
  const wrap = $('#easter-egg-playlist-wrap');
  if (!handle) return;

  wrap?.setAttribute('inert', '');

  const blockPlaylistEvent = (e) => {
    if (easterEggQueuePlaylistLocked || !easterEggQueueExpanded) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  wrap?.addEventListener('click', blockPlaylistEvent, true);
  wrap?.addEventListener('pointerup', blockPlaylistEvent, true);

  const QUEUE_DRAG_THRESHOLD = 36;
  let dragging = false;

  const toggleQueueFromHandle = () => {
    lockPlaylistInteractions();
    setEasterEggQueueExpanded(!easterEggQueueExpanded);
  };

  const finishDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    e.stopPropagation();
    e.preventDefault();
    try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const dy = easterEggQueueDragStartY - e.clientY;
    if (Math.abs(dy) >= QUEUE_DRAG_THRESHOLD) {
      lockPlaylistInteractions();
      setEasterEggQueueExpanded(dy > 0);
    } else if (!easterEggQueueDragMoved) {
      toggleQueueFromHandle();
    }
    easterEggQueueDragMoved = false;
  };

  handle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    dragging = true;
    easterEggQueueDragMoved = false;
    easterEggQueueDragStartY = e.clientY;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (Math.abs(easterEggQueueDragStartY - e.clientY) > 8) easterEggQueueDragMoved = true;
  });

  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);

  handle.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, true);

  handle.addEventListener('touchend', (e) => {
    e.preventDefault();
  }, { passive: false });

  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleQueueFromHandle();
    }
  });
}

function easterEggCoverUrl(path) {
  const url = new URL(path, window.location.href);
  url.searchParams.set('v', EASTER_EGG_COVER_VERSION);
  return url.href;
}

function easterEggSessionArtwork(track) {
  const base = track.sessionArtBase
    || track.cover.replace('/easter-egg/cover-', '').replace(/\.webp$/, '').replace(/\.jpg$/, '');
  const sizes = track.sessionArtSizes || [512, 256, 96];
  return sizes.map((size) => ({
    src: easterEggCoverUrl(`/easter-egg/cover-${base}-${size}.jpg`),
    sizes: `${size}x${size}`,
    type: 'image/jpeg',
  }));
}

function setupEasterEggMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => {
    $('#easter-egg-audio')?.play().then(() => updateEasterEggPlayerUI()).catch(() => {});
  });
  ms.setActionHandler('pause', () => {
    $('#easter-egg-audio')?.pause();
    updateEasterEggPlayerUI();
  });
  const seekBy = (delta) => {
    const audio = $('#easter-egg-audio');
    if (!audio) return;
    seekEasterEggTo((audio.currentTime || 0) + delta);
    updateEasterEggPlayerUI();
  };
  try { ms.setActionHandler('seekbackward', (details) => seekBy(-(details?.seekOffset || 10))); } catch { /* ignore */ }
  try { ms.setActionHandler('seekforward', (details) => seekBy(details?.seekOffset || 10)); } catch { /* ignore */ }
  try {
    ms.setActionHandler('seekto', (details) => {
      if (!Number.isFinite(details?.seekTime)) return;
      seekEasterEggTo(details.seekTime);
      updateEasterEggPlayerUI();
    });
  } catch { /* ignore */ }
  ms.setActionHandler('previoustrack', () => playPrevEasterEggTrack());
  ms.setActionHandler('nexttrack', () => playNextEasterEggTrack());
}

function updateEasterEggMediaSession(track) {
  if (!('mediaSession' in navigator)) return;
  const audio = $('#easter-egg-audio');
  const t = track || EASTER_EGG_PLAYLIST[easterEggTrackIndex];
  if (!t) return;

  try {
    // Clear first so iOS does not keep the previous track artwork
    navigator.mediaSession.metadata = null;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist,
      album: 'Golden Gate',
      artwork: easterEggSessionArtwork(t),
    });
  } catch { /* ignore */ }

  if (!audio) return;
  navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
  if (Number.isFinite(audio.duration) && audio.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.currentTime, audio.duration),
      });
    } catch { /* ignore */ }
  }
}

function clearEasterEggMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = 'none';
}

function renderEasterEggPlaylist() {
  const el = $('#easter-egg-playlist');
  if (!el) return;
  el.innerHTML = EASTER_EGG_PLAYLIST.map((track, i) => `
    <button type="button" class="easter-egg-playlist-item${i === easterEggTrackIndex ? ' active' : ''}" data-index="${i}">
      <img class="easter-egg-playlist-thumb" src="${easterEggCoverUrl(track.cover)}" alt="">
      <div class="easter-egg-playlist-meta">
        <div class="easter-egg-playlist-title">${esc(track.title)}</div>
        <div class="easter-egg-playlist-artist">${esc(track.artist)}</div>
      </div>
    </button>
  `).join('');
  el.querySelectorAll('.easter-egg-playlist-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (easterEggQueuePlaylistLocked || !$('#easter-egg-queue-sheet')?.classList.contains('is-expanded')) return;
      const idx = Number(btn.dataset.index);
      if (idx !== easterEggTrackIndex) loadEasterEggTrack(idx, true);
      else {
        const audio = $('#easter-egg-audio');
        if (audio?.paused) audio.play().then(() => updateEasterEggPlayerUI()).catch(() => {});
      }
      vibrate(10);
    });
  });
}

function loadEasterEggTrack(index, autoplay = false) {
  const audio = $('#easter-egg-audio');
  const track = EASTER_EGG_PLAYLIST[index];
  if (!audio || !track) return;

  easterEggTrackIndex = index;
  audio.src = `${track.src}?v=${EASTER_EGG_COVER_VERSION}`;
  const coverEl = $('#easter-egg-cover');
  if (coverEl) {
    const coverUrl = easterEggCoverUrl(track.cover);
    coverEl.removeAttribute('src');
    coverEl.src = coverUrl;
  }
  const titleEl = $('#easter-egg-track-title');
  const artistEl = $('#easter-egg-track-artist');
  if (titleEl) titleEl.textContent = track.title;
  if (artistEl) artistEl.textContent = track.artist;
  renderEasterEggPlaylist();
  updateEasterEggMediaSession(track);

  const startPlayback = () => {
    updateEasterEggMediaSession(track);
    if (!autoplay) {
      updateEasterEggPlayerUI();
      return;
    }
    audio.currentTime = 0;
    audio.play().then(() => updateEasterEggPlayerUI()).catch(() => updateEasterEggPlayerUI());
  };

  audio.load();
  if (audio.readyState >= 1) startPlayback();
  else audio.addEventListener('loadedmetadata', startPlayback, { once: true });
}

function playNextEasterEggTrack() {
  const next = (easterEggTrackIndex + 1) % EASTER_EGG_PLAYLIST.length;
  loadEasterEggTrack(next, true);
  vibrate(10);
}

function updateEasterEggPlayerUI() {
  const audio = $('#easter-egg-audio');
  const timeCurrent = $('#easter-egg-time-current');
  const timeTotal = $('#easter-egg-time-total');
  const playBtn = $('#easter-egg-play');
  if (!audio) return;

  const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
  if (!easterEggScrubbing) setEasterEggScrubber(pct);
  if (timeCurrent) timeCurrent.textContent = formatAudioTime(audio.currentTime);
  if (timeTotal) timeTotal.textContent = formatAudioTime(audio.duration);

  const playing = !audio.paused;
  playBtn?.querySelector('.easter-egg-icon-play')?.classList.toggle('hidden', playing);
  playBtn?.querySelector('.easter-egg-icon-pause')?.classList.toggle('hidden', !playing);
  if (playBtn) playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  updateEasterEggMediaSession();
}

function openEasterEgg() {
  const overlay = $('#easter-egg-overlay');
  const audio = $('#easter-egg-audio');
  if (!overlay) return;

  const hasActivePlayback = !!(audio?.src && (audio.currentTime > 0 || !audio.paused));

  setThemeColor(THEME_COLORS.easterEgg);
  overlay.classList.remove('hidden');
  lockBodyScroll();
  setEasterEggQueueExpanded(false);
  lockEasterEggInteractions();

  if (hasActivePlayback) {
    const track = EASTER_EGG_PLAYLIST[easterEggTrackIndex];
    if (track) {
      const coverEl = $('#easter-egg-cover');
      if (coverEl) coverEl.src = easterEggCoverUrl(track.cover);
      const titleEl = $('#easter-egg-track-title');
      const artistEl = $('#easter-egg-track-artist');
      if (titleEl) titleEl.textContent = track.title;
      if (artistEl) artistEl.textContent = track.artist;
    }
    renderEasterEggPlaylist();
    updateEasterEggPlayerUI();
    updateEasterEggMediaSession(track);
    if (audio.paused) audio.play().then(() => updateEasterEggPlayerUI()).catch(() => {});
  } else {
    easterEggTrackIndex = 0;
    loadEasterEggTrack(0, true);
  }
  vibrate(20);
}

function hideEasterEggOverlay() {
  const overlay = $('#easter-egg-overlay');
  clearTimeout(easterEggUnlockTimer);
  easterEggUnlockTimer = null;
  overlay?.classList.remove('is-interaction-locked');
  setThemeColor(THEME_COLORS.app);
  overlay?.classList.add('hidden');
  unlockBodyScroll();
  setEasterEggQueueExpanded(false);
}

function backgroundEasterEgg() {
  hideEasterEggOverlay();
  updateEasterEggMediaSession();
  vibrate(10);
}

function closeEasterEgg() {
  const audio = $('#easter-egg-audio');
  hideEasterEggOverlay();
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    easterEggTrackIndex = 0;
    updateEasterEggPlayerUI();
    clearEasterEggMediaSession();
  }
}

$('#easter-egg-play')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const audio = $('#easter-egg-audio');
  if (!audio) return;
  if (audio.paused) {
    audio.play().then(() => updateEasterEggPlayerUI()).catch(() => {});
  } else {
    audio.pause();
    updateEasterEggPlayerUI();
  }
  vibrate(10);
});

$('#easter-egg-prev')?.addEventListener('click', (e) => {
  e.stopPropagation();
  playPrevEasterEggTrack();
});

$('#easter-egg-next')?.addEventListener('click', (e) => {
  e.stopPropagation();
  playNextEasterEggTrack();
});

const easterEggScrubber = $('#easter-egg-scrubber');

function startEasterEggScrub(e) {
  e.preventDefault();
  e.stopPropagation();
  easterEggScrubbing = true;
  easterEggScrubPointerId = e.pointerId;
  easterEggScrubber?.classList.add('is-dragging');
  try { easterEggScrubber?.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  seekEasterEggFromEvent(e);
}

easterEggScrubber?.addEventListener('pointerdown', startEasterEggScrub);

easterEggScrubber?.addEventListener('pointermove', (e) => {
  if (!easterEggScrubbing || e.pointerId !== easterEggScrubPointerId) return;
  seekEasterEggFromEvent(e);
});

function endEasterEggScrub(e) {
  if (!easterEggScrubbing) return;
  if (e.pointerId !== easterEggScrubPointerId) return;
  easterEggScrubbing = false;
  easterEggScrubPointerId = null;
  easterEggScrubber?.classList.remove('is-dragging');
  try { easterEggScrubber?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  updateEasterEggPlayerUI();
}

easterEggScrubber?.addEventListener('pointerup', endEasterEggScrub);
easterEggScrubber?.addEventListener('pointercancel', endEasterEggScrub);

$('#easter-egg-audio')?.addEventListener('timeupdate', updateEasterEggPlayerUI);
$('#easter-egg-audio')?.addEventListener('loadedmetadata', updateEasterEggPlayerUI);
$('#easter-egg-audio')?.addEventListener('play', updateEasterEggPlayerUI);
$('#easter-egg-audio')?.addEventListener('pause', updateEasterEggPlayerUI);
$('#easter-egg-audio')?.addEventListener('ended', playNextEasterEggTrack);

renderEasterEggPlaylist();
setupEasterEggMediaSession();
setupEasterEggQueueSheet();

$('#easter-egg-background')?.addEventListener('click', (e) => {
  e.stopPropagation();
  backgroundEasterEgg();
});

$('#easter-egg-close')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeEasterEgg();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#easter-egg-overlay')?.classList.contains('hidden')) {
    e.preventDefault();
  }
});

// --- Push Notifications ---
async function isPushActive() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}

async function enablePushNotifications() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission denied');

  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await API.getVapidKey();

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await API.subscribePush(sub.toJSON());
}

async function disablePushNotifications() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  await API.unsubscribePush(sub.endpoint);
  await sub.unsubscribe();
}

window.togglePushNotifications = async () => {
  if (!hasPerm('push.subscribe')) return toast('You do not have permission', true);
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return toast('This device does not support push notifications', true);
  }

  try {
    if (await isPushActive()) {
      await disablePushNotifications();
      vibrate(20);
      toast('Notifications turned off');
    } else {
      await enablePushNotifications();
      vibrate(20);
      toast('Notifications enabled!');
    }
    if ($('#page-more')?.classList.contains('active')) await loadMore();
  } catch (err) {
    toast(err.message || 'Notification action failed', true);
  }
};

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function setupPushNotifications() {
  if (Notification.permission !== 'granted') return;
  // Always re-sync so account switches rebind the device subscription to the current user
  try { await enablePushNotifications(); } catch { /* silent */ }
}

// --- Monthly Reports ---
function renderReportTx(t) {
  const badge = PAYMENT_BADGE[t.payment_method] || '';
  const showBadge = t.payment_method && t.payment_method !== 'none';
  const creator = recordCreatorLabel(t);
  const subtitle = getTransactionSubtitle(t);
  return `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title title-with-icon">${txIconHtml(t, 16)}<span>${esc(getTransactionTitle(t))}${t.amount > 0 ? ` — ${formatMoney(t.amount)}` : ''}</span></div>
        <div class="list-item-subtitle">
          ${creator ? `<span>${esc(creator)}</span>` : ''}
          ${subtitle ? `${creator ? ' · ' : ''}${esc(subtitle)}` : ''}
          ${showBadge ? `<span class="badge ${badge}">${PAYMENT_LABELS[t.payment_method]}</span>` : ''}
          · ${formatDate(t.created_at)}
        </div>
        ${t.notes ? `<div class="note-line text-sm text-secondary mt-8">${noteIcon()}<span>${esc(t.notes)}</span></div>` : ''}
      </div>
    </div>`;
}

function renderReportExp(e) {
  const cat = CATEGORIES[e.category] || CATEGORIES.diger;
  const badge = PAYMENT_BADGE[e.payment_method] || '';
  const creator = recordCreatorLabel(e);
  return `
    <div class="list-item">
      <div class="list-item-body">
        <div class="list-item-title title-with-icon">${icon(cat.icon, { size: 16, color: cat.color })}<span>${esc(e.description)} — ${formatMoney(e.amount)}</span></div>
        <div class="list-item-subtitle">
          ${creator ? `<span>${esc(creator)}</span> · ` : ''}
          ${esc(cat.label)}
          ${badge ? `<span class="badge ${badge}">${PAYMENT_LABELS[e.payment_method]}</span>` : ''}
          ${e.vendor ? ` · ${esc(e.vendor)}` : ''}
          · ${formatDate(e.created_at)}
        </div>
        ${e.notes ? `<div class="note-line text-sm text-secondary mt-8">${noteIcon()}<span>${esc(e.notes)}</span></div>` : ''}
      </div>
    </div>`;
}

window.showMonthlyReports = async (selectedYear) => {
  if (!hasPerm('shift.view.all')) return toast('You do not have permission', true);
  const yearHint = Number.parseInt(String(selectedYear || ''), 10);
  openSheet('Monthly Reports', '<div class="spinner" style="margin:40px auto"></div>', null);
  try {
    const params = new URLSearchParams();
    if (Number.isFinite(yearHint)) params.set('year', String(yearHint));
    const data = await API.getReportMonths(params.toString());
    if (!$('#sheet-overlay')?.classList.contains('open')) return;
    const year = data.year || yearHint || Number(istanbulDateStr().slice(0, 4));
    const years = (data.years?.length ? data.years : [year]);
    const months = data.months || [];
    const yearOptions = years.map((y) =>
      `<option value="${y}"${Number(y) === Number(year) ? ' selected' : ''}>${y}</option>`
    ).join('');
    const listHtml = months.length
      ? `<div class="list-group" style="box-shadow:none">
          ${months.map((m) => `
            <div class="list-item" onclick="window.viewMonthReport('${esc(m.year_month)}')">
              <div class="list-item-body">
                <div class="list-item-title">${esc(m.label)}</div>
                <div class="list-item-subtitle">
                  Income ${formatMoney(m.income_total)} · Expense ${formatMoney(m.expense_total)} · Net ${formatMoney(m.net)}
                </div>
                <div class="list-item-subtitle">
                  ${(m.transaction_count || 0) + (m.expense_count || 0)} records
                </div>
              </div>
              <span class="list-item-chevron">›</span>
            </div>`).join('')}
        </div>`
      : emptyState('receipt', `No reports for ${year}`, 'No records found for this year');

    $('#sheet-body').innerHTML = `
      <div class="form-group reports-year-filter">
        <label class="form-label" for="reports-year">Year</label>
        <select id="reports-year">${yearOptions}</select>
      </div>
      <div id="reports-months-list">${listHtml}</div>`;

    $('#reports-year')?.addEventListener('change', (e) => {
      const nextYear = Number.parseInt(e.target.value, 10);
      if (Number.isFinite(nextYear)) window.showMonthlyReports(nextYear);
    });
  } catch (err) {
    if ($('#sheet-overlay')?.classList.contains('open')) closeSheet();
    toast(err.message, true);
  }
};

window.viewMonthReport = async (ym) => {
  if (!hasPerm('shift.view.all')) return toast('You do not have permission', true);
  openSheet('Monthly Report', '<div class="spinner" style="margin:40px auto"></div>', null);
  const sheetObserver = new MutationObserver(() => {
    if (!$('#sheet-overlay').classList.contains('open')) {
      sheetObserver.disconnect();
      $('#sheet-save').style.display = '';
      $('#sheet-save').textContent = 'Save';
    }
  });
  sheetObserver.observe($('#sheet-overlay'), { attributes: true, attributeFilter: ['class'] });

  try {
    const data = await API.getMonthReport(ym);
    if (!$('#sheet-overlay')?.classList.contains('open')) return;
    const s = data.stats || {};
    const txs = data.transactions || [];
    const exps = data.expenses || [];
    const byMethod = (s.income_by_method || []).map((m) => `
      <div class="detail-row">
        <span class="detail-label">${esc(PAYMENT_LABELS[m.payment_method] || m.payment_method || '—')}</span>
        <span>${m.count || 0} · ${formatMoney(m.total)}</span>
      </div>`).join('');
    const byCategory = (s.expense_by_category || []).map((c) => {
      const cat = CATEGORIES[c.category] || CATEGORIES.diger;
      return `
        <div class="detail-row">
          <span class="detail-label">${esc(cat.label)}</span>
          <span>${c.count || 0} · ${formatMoney(c.total)}</span>
        </div>`;
    }).join('');

    $('#sheet-title').textContent = data.label || 'Monthly Report';
    $('#sheet-body').innerHTML = `
      <div class="detail-section">
        <div class="detail-row"><span class="detail-label">Income</span><span style="color:var(--green);font-weight:600">${formatMoney(s.income_total)}</span></div>
        <div class="detail-row"><span class="detail-label">Expense</span><span style="color:var(--red);font-weight:600">${formatMoney(s.expense_total)}</span></div>
        <div class="detail-row"><span class="detail-label">Net</span><span style="font-weight:700">${formatMoney(s.net)}</span></div>
        <div class="detail-row"><span class="detail-label">Unpaid agency</span><span>${s.agency_count || 0}</span></div>
        <div class="detail-row"><span class="detail-label">Pay-at-door agency</span><span>${s.agency_pay_at_door_count || 0}</span></div>
        <div class="detail-row"><span class="detail-label">Walk-in</span><span>${s.walk_in_count || 0}</span></div>
      </div>
      ${byMethod ? `<div class="list-group-title">Income by payment method</div><div class="detail-section">${byMethod}</div>` : ''}
      ${byCategory ? `<div class="list-group-title">Expenses by category</div><div class="detail-section">${byCategory}</div>` : ''}
      <div class="list-group-title">Income & Entries (${txs.length})</div>
      ${txs.length ? txs.map(renderReportTx).join('') : '<div class="text-secondary text-center" style="padding:16px">No records</div>'}
      <div class="list-group-title">Expenses (${exps.length})</div>
      ${exps.length ? exps.map(renderReportExp).join('') : '<div class="text-secondary text-center" style="padding:16px">No records</div>'}`;

    state.sheetCloseOnSave = false;
    state.sheetCallback = async () => {
      const name = downloadMonthlyExcel(data);
      toast(`${name} downloaded`);
    };
    const saveBtn = $('#sheet-save');
    saveBtn.style.display = '';
    saveBtn.textContent = 'Excel';
    saveBtn.disabled = false;
  } catch (err) {
    if ($('#sheet-overlay')?.classList.contains('open')) closeSheet();
    toast(err.message, true);
  }
};

// --- Admin: Users ---
window.showUsers = async () => {
  if (!isRoot()) return toast('This action can only be performed by an administrator', true);
  try {
    const users = await API.getUsers();
    openSheet('Users', `
      <button class="btn btn-primary btn-block mb-8" onclick="window.showCreateUser()">+ New User</button>
      <div class="list-group" style="box-shadow:none">
        ${users.map((u) => `
          <div class="list-item" onclick="window.showEditUser('${u.id}')">
            <div class="list-item-body">
              <div class="list-item-title">${esc(u.display_name)} ${u.is_active ? '' : '(Inactive)'}</div>
              <div class="list-item-subtitle">@${esc(u.username)} · ${(u.permissions || []).length} permissions</div>
            </div>
            <span class="list-item-chevron">›</span>
          </div>`).join('') || '<div class="text-secondary text-center" style="padding:16px">No users</div>'}
      </div>`, null);
  } catch (err) {
    toast(err.message, true);
  }
};

window.showCreateUser = () => {
  if (!isRoot()) return toast('This action can only be performed by an administrator', true);
  closeSheet();
  setTimeout(() => {
    openSheet('New User', `
      <div class="form-group">
        <label class="form-label">Username</label>
        <input type="text" id="f-username" placeholder="username" required>
      </div>
      <div class="form-group">
        <label class="form-label">Display Name</label>
        <input type="text" id="f-display-name" placeholder="Full name" required>
      </div>
      <div class="form-group">
        <label class="form-label">Password</label>
        <input type="password" id="f-password" placeholder="Password" required>
      </div>
      <div class="form-group">
        <label class="form-label">Permissions</label>
        ${renderPermissionSwitches()}
      </div>`, async () => {
      await API.createUser({
        username: $('#f-username').value.trim(),
        display_name: $('#f-display-name').value.trim(),
        password: $('#f-password').value,
        permissions: collectPermissions(),
      });
      toast('User created!');
    }, { saveLabel: 'Add' });
  }, 300);
};

window.showEditUser = async (id) => {
  if (!isRoot()) return toast('This action can only be performed by an administrator', true);
  try {
    const users = await API.getUsers();
    const user = users.find((u) => u.id === id);
    if (!user) return toast('User not found', true);

    closeSheet();
    setTimeout(() => {
      openSheet('Edit User', `
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <input type="text" id="f-display-name" value="${esc(user.display_name)}" required>
        </div>
        <div class="form-group">
          <label class="form-label">New Password</label>
          <input type="password" id="f-password" placeholder="Enter to change">
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <div class="payment-pills" id="f-status">
            <div class="payment-pill${user.is_active ? ' active' : ''}" data-value="1">Active</div>
            <div class="payment-pill${!user.is_active ? ' active' : ''}" data-value="0">Inactive</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Permissions</label>
          ${renderPermissionSwitches(user.permissions || [])}
        </div>`, async () => {
        const data = {
          display_name: $('#f-display-name').value.trim(),
          is_active: getSelectedPill('f-status') === '1',
          permissions: collectPermissions(),
        };
        const pwd = $('#f-password').value;
        if (pwd) data.password = pwd;
        await API.updateUser(id, data);
        toast('User updated!');
      });
      setupPillHandlers($('#sheet-body'));
    }, 300);
  } catch (err) {
    toast(err.message, true);
  }
};

// --- Admin: Audit Logs ---
const ACTION_LABELS = {
  LOGIN_SUCCESS: 'Login successful',
  LOGIN_FAILED: 'Login failed',
  SHIFT_OPENED: 'Shift opened',
  SHIFT_CLOSED: 'Shift closed',
  INCOME_CREATED: 'Income added',
  AGENCY_ENTRY_CREATED: 'Agency entry',
  AGENCY_PAY_AT_DOOR_CREATED: 'Pay-at-door agency',
  WALK_IN_CREATED: 'Walk-in',
  EXPENSE_CREATED: 'Expense added',
  TRANSACTION_UPDATED: 'Record updated',
  TRANSACTION_DELETED: 'Record deleted',
  EXPENSE_UPDATED: 'Expense updated',
  EXPENSE_DELETED: 'Expense deleted',
  USER_CREATED: 'User created',
  USER_UPDATED: 'User updated',
  PUSH_SUBSCRIBED: 'Push subscribed',
  PUSH_UNSUBSCRIBED: 'Push unsubscribed',
};

const auditFilterState = { q: '', period: 'all', customFrom: '', customTo: '', action: '' };
let auditSearchTimer;

function actionLabel(action) {
  return ACTION_LABELS[action] || action;
}

function buildAuditQuery(offset = 0) {
  const params = new URLSearchParams({
    limit: String(AUDIT_PAGE_SIZE),
    offset: String(offset),
  });
  if (auditFilterState.q) params.set('q', auditFilterState.q);
  if (auditFilterState.action) params.set('action', auditFilterState.action);
  const bounds = getPeriodBounds(auditFilterState.period, auditFilterState);
  if (bounds.from) params.set('from', bounds.from);
  if (bounds.to) params.set('to', bounds.to);
  return params.toString();
}

function renderAuditLogItems(logs) {
  if (!logs.length) return '';
  return logs.map((l) => `
    <div class="audit-log-item">
      <div class="flex-between">
        <span class="audit-log-action">${esc(actionLabel(l.action))}</span>
        <span class="text-secondary">${formatDate(l.created_at)}</span>
      </div>
      <div class="audit-log-meta">
        ${esc(l.username || '—')}${l.entity_type ? ` · ${esc(l.entity_type)}/${esc(l.entity_id?.slice(0, 8) || '')}` : ''}
      </div>
      ${l.details ? `<div class="audit-log-details">${esc(l.details.slice(0, 160))}</div>` : ''}
    </div>`).join('');
}

window.loadMoreAuditLogs = () => loadAuditLogResults(true);

async function loadAuditLogResults(append = false) {
  const list = $('#audit-log-list');
  if (!list) return;

  if (!append) {
    auditPagination.offset = 0;
    list.innerHTML = '<div class="spinner"></div>';
  } else {
    const btn = list.querySelector('.btn-load-more');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }
  }

  try {
    const data = await API.getAuditLogs(buildAuditQuery(append ? auditPagination.offset : 0));
    const logs = data.items || [];
    auditPagination.offset += logs.length;
    auditPagination.hasMore = data.pagination?.hasMore;

    if (!logs.length && !append) {
      list.innerHTML = '<div class="text-center text-secondary" style="padding:24px">No records found</div>';
      return;
    }

    const footer = paginationFooter(auditPagination.hasMore, 'window.loadMoreAuditLogs()', auditPagination.offset);

    if (append) {
      list.querySelector('.audit-log-items')?.insertAdjacentHTML('beforeend', renderAuditLogItems(logs));
      const bar = list.querySelector('.pagination-bar');
      if (bar) bar.outerHTML = footer;
    } else {
      list.innerHTML = `<div class="audit-log-items">${renderAuditLogItems(logs)}</div>${footer}`;
    }
  } catch (err) {
    if (!append) {
      list.innerHTML = `<div class="text-center text-secondary" style="padding:24px">${esc(err.message)}</div>`;
    } else {
      toast(err.message, true);
      const btn = list.querySelector('.btn-load-more');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Show more';
      }
    }
  }
}

function auditLogsSheetHTML(actionOptions) {
  return `
    <div class="search-bar" style="margin-bottom:12px">
      <span class="search-bar-icon">${icon('search', { size: 16, color: 'var(--text-secondary)' })}</span>
      <input type="search" id="audit-search" placeholder="Search user, action, details..." autocomplete="off" value="${esc(auditFilterState.q)}">
    </div>
    <div class="filter-row">
      <div class="custom-picker" id="audit-period-picker">
        <button type="button" class="picker-trigger" id="audit-period-trigger">
          <span class="picker-trigger-label" id="audit-period-label">All dates</span>
          <span class="picker-trigger-caret" aria-hidden="true">${PICKER_CARET_SVG}</span>
        </button>
        <div class="picker-menu" id="audit-period-menu"></div>
      </div>
      <div class="custom-picker" id="audit-action-picker">
        <button type="button" class="picker-trigger" id="audit-action-trigger">
          <span class="picker-trigger-label" id="audit-action-label">All actions</span>
          <span class="picker-trigger-caret" aria-hidden="true">${PICKER_CARET_SVG}</span>
        </button>
        <div class="picker-menu" id="audit-action-menu"></div>
      </div>
    </div>
    ${periodCustomDatesHTML('audit')}
    <div class="audit-log-list" id="audit-log-list">
      <div class="spinner"></div>
    </div>`;
}

window.showAuditLogs = async () => {
  if (!hasPerm('audit.view')) return toast('You do not have permission', true);
  try {
    auditFilterState.q = '';
    auditFilterState.period = 'all';
    auditFilterState.customFrom = '';
    auditFilterState.customTo = '';
    auditFilterState.action = '';
    auditPagination = { offset: 0, hasMore: false };

    const actions = await API.getAuditActions();
    const actionOptions = [
      { value: '', label: 'All actions' },
      ...actions.map((a) => ({ value: a, label: actionLabel(a) })),
    ];

    openSheet('System Logs', auditLogsSheetHTML(actionOptions), null);
    $('#sheet-save').style.display = 'none';

    setupPeriodFilter({
      idPrefix: 'audit',
      state: auditFilterState,
      onChange: () => {
        auditPagination.offset = 0;
        loadAuditLogResults();
      },
    });

    setupCustomPicker('audit-action', actionOptions, auditFilterState.action, (value) => {
      auditFilterState.action = value;
      auditPagination.offset = 0;
      loadAuditLogResults();
    });

    $('#audit-search').addEventListener('input', (e) => {
      clearTimeout(auditSearchTimer);
      auditFilterState.q = e.target.value.trim();
      auditPagination.offset = 0;
      auditSearchTimer = setTimeout(loadAuditLogResults, 300);
    });

    const sheetObserver = new MutationObserver(() => {
      if (!$('#sheet-overlay').classList.contains('open')) {
        sheetObserver.disconnect();
        $('#sheet-save').style.display = '';
      }
    });
    sheetObserver.observe($('#sheet-overlay'), { attributes: true, attributeFilter: ['class'] });

    await loadAuditLogResults();
  } catch (err) {
    toast(err.message, true);
  }
};

// --- Init ---
init();
