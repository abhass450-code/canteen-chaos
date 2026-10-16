/* ------------------------------------------------------------------
   api.js - every network call lives here.
   Nothing else in the app should call fetch() directly.
   ------------------------------------------------------------------ */

const API_BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    throw new Error('The server sent something that was not JSON');
  }

  // the server can answer 200 and still report a problem inside the body
  if (!res.ok || (body && body.status === 'error')) {
    const message = (body && (body.error || body.message)) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.details = body && body.details;
    throw err;
  }

  return body;
}

const api = {
  getMenu({ veg = 'all', q = '' } = {}) {
    const params = new URLSearchParams();
    if (veg !== 'all') params.set('veg', veg);
    if (q) params.set('q', q);
    const query = params.toString();
    return request('/menu' + (query ? `?${query}` : ''));
  },
  getSuggestions(q) {
    const params = new URLSearchParams({ q });
    return request(`/menu/suggest?${params.toString()}`);
  },

  getDish(id) {
    return request(`/menu/${id}`);
  },

  placeOrder(items) {
    return request('/orders', {
      method: 'POST',
      body: JSON.stringify({ items }),
    });
  },

  getOrder(token) {
    return request(`/orders/${token}`);
  },
};
