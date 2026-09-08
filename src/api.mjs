const DEFAULT_BASE = 'https://services.rappi.com.br';
const READ_TIMEOUT_MS = 15_000;
const CHECKOUT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const STORE_TYPES = new Set(['market', 'turbo', 'restaurant', 'pharmacy', 'express', 'liquor']);

export class ApiError extends Error {
  constructor(message, { status = null, ambiguous = false, payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.ambiguous = ambiguous;
    this.payload = payload;
  }
}

export class SessionExpiredError extends ApiError {
  constructor(status) {
    super(`Saved Rappi session was rejected with HTTP ${status}. Run auth login again.`, { status });
    this.name = 'SessionExpiredError';
  }
}

export function cleanRemote(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u001b]/g, ' ').trim();
}

export function finiteMoney(value, label) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new ApiError(`${label} is not a finite nonnegative amount.`);
  return Number(number.toFixed(2));
}

export function moneyToCents(value, label) {
  return Math.round(finiteMoney(value, label) * 100);
}

export function parseEta(value) {
  const text = cleanRemote(value);
  const range = text.match(/(\d+)\s*-\s*(\d+)\s*min/i);
  if (range) return { text, minimum_minutes: Number(range[1]), maximum_minutes: Number(range[2]), immediate: true };
  const single = text.match(/(\d+)\s*min/i);
  if (single) return { text, minimum_minutes: Number(single[1]), maximum_minutes: Number(single[1]), immediate: true };
  return { text, minimum_minutes: null, maximum_minutes: null, immediate: false };
}

function requireId(value, label) {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
    throw new ApiError(`${label} is invalid.`);
  }
  const id = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new ApiError(`${label} is invalid.`);
  return id;
}

function requireStoreType(value) {
  const storeType = String(value ?? '').trim();
  if (!STORE_TYPES.has(storeType)) throw new ApiError(`Unsupported store type: ${storeType || '(empty)'}.`);
  return storeType;
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') throw new ApiError('Saved session headers are missing.');
  if (typeof headers.authorization !== 'string' || !headers.authorization.startsWith('Bearer ')) throw new ApiError('Saved bearer is invalid.');
  if (typeof headers.deviceid !== 'string' || !headers.deviceid) throw new ApiError('Saved device ID is invalid.');
  const allowed = ['authorization', 'deviceid', 'x-application-id', 'app-version', 'accept-language', 'needappsflyerid', 'af-web-id', 'cybs-fp-id'];
  const result = { accept: 'application/json', 'content-type': 'application/json' };
  for (const name of allowed) if (typeof headers[name] === 'string' && !/[\r\n]/.test(headers[name])) result[name] = headers[name];
  return result;
}

async function discardBody(body) {
  try { await body?.cancel(); }
  catch { /* A failed cancellation must not hide the response error. */ }
}

async function parseJson(response) {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await discardBody(response.body);
    throw new ApiError('Rappi API response exceeded the size limit.');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      let chunk;
      try { chunk = await reader.read(); }
      catch { throw new ApiError('Rappi API response could not be read.'); }
      const { done, value } = chunk;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await discardBody(reader);
        throw new ApiError('Rappi API response exceeded the size limit.');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new ApiError('Rappi API returned malformed JSON.'); }
}

export class RappiClient {
  constructor(headers, { baseUrl = DEFAULT_BASE, fetchImpl = fetch } = {}) {
    const parsed = new URL(baseUrl);
    if (baseUrl === DEFAULT_BASE) {
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'services.rappi.com.br' || parsed.pathname !== '/') throw new ApiError('Invalid production API origin.');
    } else if (process.env.NODE_ENV !== 'test' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      throw new ApiError('Custom API origins are allowed only for loopback tests.');
    }
    this.baseUrl = parsed.origin;
    this.headers = normalizeHeaders(headers);
    this.fetchImpl = fetchImpl;
  }

  async request(method, pathname, { body, query, timeout = READ_TIMEOUT_MS, ambiguousOnNetwork = false, headers = {} } = {}) {
    if (typeof method !== 'string' || !/^[A-Za-z]+$/.test(method)) throw new ApiError('Invalid API method.');
    method = method.toUpperCase();
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('..') || /[\\#\u0000-\u0020\u007f-\u009f]/.test(pathname)) throw new ApiError('Unsafe API path.');
    const url = new URL(pathname, this.baseUrl);
    if (url.origin !== this.baseUrl) throw new ApiError('API path escaped the fixed origin.');
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const context = `${method} ${url.pathname}`;
    let dispatched = false;
    let response;
    try {
      const options = {
        method,
        headers: { ...this.headers, ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeout),
      };
      dispatched = true;
      response = await this.fetchImpl(url, options);
      if (response.status === 401 || response.status === 403) {
        await discardBody(response.body);
        throw new SessionExpiredError(response.status);
      }
      if (response.status >= 300 && response.status < 400) {
        await discardBody(response.body);
        throw new ApiError('Rappi API redirects are not allowed.');
      }
      const payload = await parseJson(response);
      if (!response.ok) throw new ApiError('Rappi API rejected the request.', { payload });
      return payload;
    } catch (error) {
      const status = response?.status ?? null;
      const failure = response && error instanceof ApiError ? error : new ApiError(response
        ? 'Rappi API response could not be read.'
        : (dispatched ? 'Rappi API request failed before a response.' : 'Rappi API request could not be prepared.'));
      failure.message = `${context}${status == null ? '' : ` (HTTP ${status})`}: ${failure.message}`;
      failure.status = status;
      failure.ambiguous = ambiguousOnNetwork && dispatched;
      throw failure;
    }
  }

  auth() {
    return this.request('GET', '/ms/application-user/auth');
  }

  addressesRaw() {
    return this.request('GET', '/api/ms/users-address/addresses');
  }

  async addresses() {
    const payload = await this.addressesRaw();
    const rows = Array.isArray(payload) ? payload : (payload?.addresses ?? payload?.data ?? []);
    if (!Array.isArray(rows)) throw new ApiError('Address response has an invalid shape.');
    return rows.map((row) => ({
      id: requireId(row.id, 'address.id'),
      active: Boolean(row.active),
      label: cleanRemote(row.tag ?? row.description ?? 'Endereço'),
      city: cleanRemote(row.city?.name ?? row.city?.description ?? row.city?.city ?? (typeof row.city === 'string' ? row.city : '')),
    }));
  }

  async activeLocation() {
    const payload = await this.addressesRaw();
    const rows = Array.isArray(payload) ? payload : (payload?.addresses ?? payload?.data ?? []);
    if (!Array.isArray(rows)) throw new ApiError('Address response has an invalid shape.');
    const row = rows.find((entry) => entry.active);
    const lat = Number(row?.lat);
    const lng = Number(row?.lng);
    if (!row || !Number.isFinite(lat) || !Number.isFinite(lng)) throw new ApiError('No active delivery location is available.');
    return {
      id: requireId(row.id, 'address.id'),
      lat,
      lng,
      label: cleanRemote(row.tag ?? row.description ?? 'Endereço'),
      zone_id: row.zone?.id == null ? null : requireId(row.zone.id, 'address.zone.id'),
      zone_name: cleanRemote(row.zone?.name),
    };
  }

  async setActiveAddress(addressId) {
    const id = requireId(addressId, 'address id');
    await this.request('PUT', `/api/ms/users-address/addresses/${encodeURIComponent(id)}/active`);
    const addresses = await this.addresses();
    if (!addresses.some((row) => row.id === id && row.active)) throw new ApiError('Rappi did not activate the requested address.');
    return addresses;
  }

  async search(query) {
    const normalized = String(query ?? '').trim();
    if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) throw new ApiError('Search query must contain 1-200 printable characters.');
    const location = await this.activeLocation();
    const payload = await this.request('POST', '/api/pns-global-search-api/v1/unified-search', {
      query: { is_prime: false },
      body: { query: normalized, lat: location.lat, lng: location.lng },
    });
    const stores = Array.isArray(payload?.stores) ? payload.stores : (Array.isArray(payload?.data?.stores) ? payload.data.stores : []);
    if (!Array.isArray(stores)) throw new ApiError('Search response has an invalid shape.');
    const results = [];
    for (const store of stores) {
      const storeId = requireId(store.store_id ?? store.id, 'store id');
      const eta = parseEta(store.eta ?? store.eta_value);
      for (const product of (Array.isArray(store.products) ? store.products : [])) {
        const price = finiteMoney(product.price, 'product.price');
        results.push({
          store_id: storeId,
          store_name: cleanRemote(store.store_name ?? store.name),
          store_type: cleanRemote(store.store_type ?? store.parent_store_type),
          parent_store_type: cleanRemote(store.parent_store_type),
          vertical: cleanRemote(store.vertical ?? store.vertical_group),
          cart_type: store.store_type === 'turbo'
            ? 'turbo'
            : (/restaurant/i.test(String(store.vertical ?? store.vertical_group)) ? 'restaurant' : 'market'),
          eta,
          shipping_cost: finiteMoney(store.shipping_cost, 'store.shipping_cost'),
          minimum_order: finiteMoney(store.mov, 'store.mov'),
          closed: Boolean(store.is_closed || store.status === 'CLOSED'),
          product_id: requireId(product.id ?? product.product_id, 'product id'),
          master_product_id: cleanRemote(product.master_product_id),
          name: cleanRemote(product.name),
          presentation: cleanRemote(product.presentation),
          ean: cleanRemote(product.ean),
          price,
          real_price: finiteMoney(product.real_price ?? product.price, 'product.real_price'),
          stock: Number.isFinite(Number(product.stock)) ? Number(product.stock) : null,
          available: product.is_available !== false && product.in_stock !== false && Number(product.stock ?? 1) !== 0,
          sale_type: cleanRemote(product.sale_type),
          minimum_units: Math.max(1, Number(product.min_purchasing_units ?? 1)),
          age_restriction: Boolean(product.age_restriction),
          requires_prescription: Boolean(product.requires_medical_prescription),
        });
      }
    }
    return { query: normalized, results };
  }

  cartsRaw() {
    return this.request('POST', '/api/ms/shopping-cart/v1/all/get', { body: {} });
  }

  ordersRaw({ timeout = READ_TIMEOUT_MS } = {}) {
    return this.request('GET', '/api/user-order-home/v3/orders', { timeout });
  }

  async replaceStoreCart(storeType, stores) {
    const type = requireStoreType(storeType);
    if (!Array.isArray(stores) || stores.length === 0) throw new ApiError('Store cart payload must be a non-empty array.');
    return this.request('PUT', `/api/ms/shopping-cart/v2/${type}/store`, { body: stores });
  }

  recalculate(storeType) {
    const type = requireStoreType(storeType);
    return this.request('POST', `/api/ms/shopping-cart/v1/${type}/recalculate`, { body: {}, timeout: CHECKOUT_TIMEOUT_MS });
  }

  checkoutDetail(storeType) {
    return this.request('GET', `/api/ms/shopping-cart/v1/${requireStoreType(storeType)}/checkout/detail`);
  }

  checkoutSummary(storeType) {
    return this.request('GET', `/api/ms/shopping-cart/v1/${requireStoreType(storeType)}/summary-v2`);
  }

  checkoutComponents(storeType, storeIds) {
    const type = requireStoreType(storeType);
    if (!Array.isArray(storeIds) || storeIds.length === 0) throw new ApiError('Store IDs must be a non-empty array.');
    const ids = Array.from(storeIds, (value) => {
      const id = requireId(value, 'store id');
      const number = Number(id);
      if (!/^\d+$/.test(id) || !Number.isSafeInteger(number) || number <= 0) throw new ApiError('Store ID must be a positive safe integer.');
      return number;
    });
    return this.request('POST', `/api/ms/checkout-component/${type}`, {
      body: { delivery_method: 'delivery', scheduled: false, store_ids: ids },
    });
  }

  tipSegmentation(storeType, storeId) {
    const type = requireStoreType(storeType);
    const id = requireId(storeId, 'store id');
    return this.request('GET', '/api/ms/core-tip/user-segmentation', {
      query: { store_type_group: type, store_type: type, store_id: id },
    });
  }

  paymentMethods(storeType, storeId, { zoneId, zoneName } = {}) {
    const type = requireStoreType(storeType);
    const id = requireId(storeId, 'store id');
    return this.request('GET', '/api/ms/payment-method/resolver/v5', {
      query: {
        origin: 'APP',
        store_type: type,
        store_id: id,
        zone_id: zoneId == null ? undefined : requireId(zoneId, 'zone id'),
        zone_name: zoneName ? cleanRemote(zoneName) : undefined,
      },
    });
  }

  selectPaymentMethod(storeType, payload) {
    const type = requireStoreType(storeType);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ApiError('Payment method payload is invalid.');
    return this.request('PUT', `/api/ms/shopping-cart/v1/${type}/payment-method`, { body: payload });
  }

  async checkout(storeType, recalculationPayload) {
    const type = requireStoreType(storeType);
    if (!recalculationPayload || typeof recalculationPayload !== 'object' || Array.isArray(recalculationPayload)) throw new ApiError('Checkout payload is invalid.');
    return this.request('POST', `/api/ms/shopping-cart-proxy/${type}/checkout`, {
      body: recalculationPayload,
      timeout: CHECKOUT_TIMEOUT_MS,
      ambiguousOnNetwork: true,
      headers: { needappsflyerid: 'true' },
    });
  }
}
