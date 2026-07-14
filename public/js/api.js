const API = {
  token: localStorage.getItem('token'),

  setToken(token) {
    this.token = token;
    if (token) localStorage.setItem('token', token);
    else localStorage.removeItem('token');
  },

  async request(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;

    const res = await fetch(`/api${path}`, { ...options, headers });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
      this.setToken(null);
      window.dispatchEvent(new Event('auth:logout'));
    }

    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  },

  login: (username, password) =>
    API.request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),

  me: () => API.request('/auth/me'),

  getActiveShift: () => API.request('/shifts/active'),
  openShift: (opening_cash) =>
    API.request('/shifts/open', { method: 'POST', body: JSON.stringify({ opening_cash }) }),
  closeShift: (id, data) =>
    API.request(`/shifts/${id}/close`, { method: 'POST', body: JSON.stringify(data) }),
  getShift: (id) => API.request(`/shifts/${id}`),
  getShifts: (params = '') => API.request(`/shifts?${params}`),

  createTransaction: (data) =>
    API.request('/transactions', { method: 'POST', body: JSON.stringify(data) }),
  updateTransaction: (id, data) =>
    API.request(`/transactions/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteTransaction: (id) =>
    API.request(`/transactions/${id}`, { method: 'DELETE' }),
  getTransactionHistory: (id) => API.request(`/transactions/${id}/history`),

  createExpense: (data) =>
    API.request('/expenses', { method: 'POST', body: JSON.stringify(data) }),
  updateExpense: (id, data) =>
    API.request(`/expenses/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteExpense: (id) =>
    API.request(`/expenses/${id}`, { method: 'DELETE' }),
  getExpenseHistory: (id) => API.request(`/expenses/${id}/history`),

  searchGuests: (params = '') => API.request(`/search/guests?${params}`),
  searchRooms: (params = '') => API.request(`/search/rooms?${params}`),
  searchGlobal: (params = '') => API.request(`/search/global?${params}`),

  getReportMonths: (params = '') => API.request(`/reports/months?${params}`),
  getMonthReport: (ym) => API.request(`/reports/months/${encodeURIComponent(ym)}`),

  getUsers: () => API.request('/auth/users'),
  getPermissions: () => API.request('/auth/permissions'),
  createUser: (data) =>
    API.request('/auth/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id, data) =>
    API.request(`/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  getAuditLogs: (params = '') => API.request(`/audit?${params}`),
  getAuditActions: () => API.request('/audit/actions'),
  getVapidKey: () => API.request('/push/vapid-key'),
  subscribePush: (subscription) =>
    API.request('/push/subscribe', { method: 'POST', body: JSON.stringify(subscription) }),
  unsubscribePush: (endpoint) =>
    API.request('/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint }) }),
};

export default API;
