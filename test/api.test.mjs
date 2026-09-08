import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { RappiClient, ApiError, SessionExpiredError } from '../src/api.mjs';

process.env.NODE_ENV = 'test';
const headers = { authorization: 'Bearer fixture-value', deviceid: 'device-fixture' };

function response(value, status = 200) {
  return new Response(value == null ? '' : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('client rejects non-loopback custom origin', () => {
  assert.throws(() => new RappiClient(headers, { baseUrl: 'https://evil.example/' }), /loopback tests/);
});

test('search uses fixed endpoints, active location, and sanitizes remote text', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (url.pathname.endsWith('/addresses')) return response([{ id: 7, active: true, lat: -22, lng: -43, tag: 'Saved address' }]);
    if (url.pathname.endsWith('/unified-search')) return response({ stores: [{
      store_id: 10, store_name: 'Store\u001b[31m', eta: '12 - 15 min', shipping_cost: 2, mov: 15,
      products: [{ id: '10_20', name: 'Monster\u0000', price: 10, real_price: 12, stock: 3, sale_type: 'U' }],
    }] });
    throw new Error('unexpected request');
  };
  const client = new RappiClient(headers, { baseUrl: 'http://127.0.0.1:12345/', fetchImpl });
  const result = await client.search('Monster');
  assert.equal(calls[1].url, 'http://127.0.0.1:12345/api/pns-global-search-api/v1/unified-search?is_prime=false');
  assert.deepEqual(JSON.parse(calls[1].options.body), { query: 'Monster', lat: -22, lng: -43 });
  assert.equal(result.results[0].store_name, 'Store [31m');
  assert.equal(result.results[0].name, 'Monster');
  assert.equal(result.results[0].eta.maximum_minutes, 15);
  assert.equal(calls[0].options.headers.authorization, 'Bearer fixture-value');
});

test('restaurant menu exposes sanitized descriptions by compound product ID', async () => {
  const calls = [];
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async url => {
      calls.push(String(url));
      return response({ corridors: [
        { products: [{ id: '10_20', description: 'Arroz, feijão\u0000 e frango.' }] },
        { products: [{ id: '10_21', description: '' }] },
      ] });
    },
  });
  const descriptions = await client.restaurantMenuDescriptions('10');
  assert.equal(calls[0], 'http://127.0.0.1:12345/api/restaurant-bus/store/10/menu');
  assert.equal(descriptions.get('10_20'), 'Arroz, feijão  e frango.');
  assert.equal(descriptions.get('10_21'), null);
});

test('authentication rejection has a dedicated error', async () => {
  const client = new RappiClient(headers, { baseUrl: 'http://127.0.0.1:12345/', fetchImpl: async () => response({ error: true }, 401) });
  await assert.rejects(() => client.auth(), SessionExpiredError);
});

test('checkout network failure is ambiguous and never retried', async () => {
  let calls = 0;
  const client = new RappiClient(headers, { baseUrl: 'http://127.0.0.1:12345/', fetchImpl: async () => { calls += 1; throw new Error('socket closed'); } });
  await assert.rejects(() => client.checkout('market', { final_total: 10 }), error => error instanceof ApiError && error.ambiguous === true);
  assert.equal(calls, 1);
});

test('checkout HTTP rejection is also treated as ambiguous', async () => {
  const client = new RappiClient(headers, { baseUrl: 'http://127.0.0.1:12345/', fetchImpl: async () => response({ error: true }, 500) });
  await assert.rejects(() => client.checkout('market', { final_total: 10 }), error => error instanceof ApiError && error.ambiguous === true);
});

test('malformed checkout success response remains ambiguous', async () => {
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async () => new Response('{broken', { status: 200 }),
  });
  await assert.rejects(() => client.checkout('market', { total: 10 }), error => error instanceof ApiError && error.ambiguous === true);
});

test('active location never falls back to an inactive address', async () => {
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async () => response([{ id: 1, active: false, lat: -22, lng: -43 }]),
  });
  await assert.rejects(() => client.activeLocation(), /No active delivery location/);
});

test('unsafe store types cannot enter API paths', async () => {
  const client = new RappiClient(headers, { baseUrl: 'http://127.0.0.1:12345/', fetchImpl: async () => response({}) });
  assert.throws(() => client.recalculate('../evil'), /Unsupported store type/);
});

test('mapped cart and checkout helpers use exact methods and paths', async () => {
  const calls = [];
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async (url, options) => {
      calls.push([options.method, `${url.pathname}${url.search}`, options.body, options.headers]);
      return response({});
    },
  });
  await client.cartsRaw();
  await client.replaceStoreCart('market', [{ id: 1, products: [] }]);
  await client.recalculate('market');
  await client.recalculateForOrder('market');
  await client.checkoutDetail('market');
  await client.checkoutSummary('market');
  await client.checkoutComponents('market', ['1']);
  await client.tipSegmentation('market', '1');
  await client.paymentMethods('market', '1', { zoneId: '2', zoneName: 'Centro' });
  await client.selectPaymentMethod('market', { payment_method_type: 'cc' });
  await client.checkout('market', { total: 10 });
  assert.deepEqual(calls.map(([method, path]) => [method, path]), [
    ['POST', '/api/ms/shopping-cart/v1/all/get'],
    ['PUT', '/api/ms/shopping-cart/v2/market/store'],
    ['POST', '/api/ms/shopping-cart/v1/market/recalculate'],
    ['POST', '/api/ms/shopping-cart/v1/market/recalculate'],
    ['GET', '/api/ms/shopping-cart/v1/market/checkout/detail'],
    ['GET', '/api/ms/shopping-cart/v1/market/summary-v2'],
    ['POST', '/api/ms/checkout-component/market'],
    ['GET', '/api/ms/core-tip/user-segmentation?store_type_group=market&store_type=market&store_id=1'],
    ['GET', '/api/ms/payment-method/resolver/v5?origin=APP&store_type=market&store_id=1&zone_id=2&zone_name=Centro'],
    ['PUT', '/api/ms/shopping-cart/v1/market/payment-method'],
    ['POST', '/api/ms/shopping-cart-proxy/market/checkout'],
  ]);
  assert.equal(calls[0][2], '{}');
  assert.equal(calls[2][2], '{}');
  assert.equal(calls[3][2], '{"store_type":"market"}');
  assert.equal(calls[10][3].needappsflyerid, 'true');
  assert.equal(calls[10][3]['af-web-id'], 'null');
  assert.equal(calls[10][3]['cybs-fp-id'], '');
});

test('checkout preserves antifraud identifiers observed during authentication', async () => {
  let requestHeaders;
  const client = new RappiClient({
    ...headers,
    'af-web-id': 'observed-af-id',
    'cybs-fp-id': 'observed-cybs-id',
  }, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async (_url, options) => {
      requestHeaders = options.headers;
      return response({});
    },
  });
  await client.checkout('restaurant', { store_type: 'restaurant' });
  assert.equal(requestHeaders['af-web-id'], 'observed-af-id');
  assert.equal(requestHeaders['cybs-fp-id'], 'observed-cybs-id');
});

test('checkout authentication rejections remain ambiguous without retry', async () => {
  for (const status of [401, 403]) {
    let calls = 0;
    let canceled = false;
    const client = new RappiClient(headers, {
      baseUrl: 'http://127.0.0.1:12345/',
      fetchImpl: async () => {
        calls += 1;
        return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status });
      },
    });
    await assert.rejects(() => client.checkout('market', { total: 10 }), error => {
      assert.ok(error instanceof SessionExpiredError);
      assert.equal(error.ambiguous, true);
      assert.equal(error.status, status);
      assert.match(error.message, /POST \/api\/ms\/shopping-cart-proxy\/market\/checkout/);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(canceled, true);
  }
});

test('checkout body read failures are safe ambiguous API errors without retry', async () => {
  let calls = 0;
  const secret = 'private-payment-token';
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async () => {
      calls += 1;
      let reads = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(new TextEncoder().encode('{"order":'));
          else controller.error(new TypeError(`body aborted with ${secret}`));
        },
      }), { status: 200 });
    },
  });
  await assert.rejects(() => client.checkout('market', { token: secret }), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.ambiguous, true);
    assert.equal(error.status, 200);
    assert.match(error.message, /POST \/api\/ms\/shopping-cart-proxy\/market\/checkout \(HTTP 200\)/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('request errors include method and path but omit query, body and transport secrets', async () => {
  const secret = 'private-value';
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async (url, options) => { throw new Error(`${url} ${options.body} ${headers.authorization}`); },
  });
  await assert.rejects(() => client.request('POST', '/api/example?existing=private-value', {
    query: { token: secret }, body: { token: secret },
  }), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.ambiguous, false);
    assert.match(error.message, /POST \/api\/example:/);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes(headers.authorization), false);
    assert.equal(error.message.includes('?'), false);
    return true;
  });
});

test('checkout payload serialization failure is not marked as dispatched', async () => {
  let calls = 0;
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async () => { calls += 1; return response({}); },
  });
  const payload = {};
  payload.circular = payload;
  await assert.rejects(() => client.checkout('market', payload), error => error instanceof ApiError && error.ambiguous === false);
  assert.equal(calls, 0);
});

test('oversized checkout response is canceled before consuming a declared large body', async () => {
  let canceled = false;
  let reads = 0;
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async () => new Response(new ReadableStream({
      pull() { reads += 1; },
      cancel() { canceled = true; throw new Error('cancel failed'); },
    }, { highWaterMark: 0 }), { headers: { 'content-length': String(20 * 1024 * 1024 + 1) } }),
  });
  await assert.rejects(() => client.checkout('market', { total: 10 }), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.ambiguous, true);
    assert.equal(error.status, 200);
    assert.match(error.message, /size limit/);
    return true;
  });
  assert.equal(reads, 0);
  assert.equal(canceled, true);
});

test('chunked checkout responses are capped while reading even with a false content length', async () => {
  for (const responseHeaders of [{}, { 'content-length': '1' }]) {
    let reads = 0;
    let canceled = false;
    let calls = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const client = new RappiClient(headers, {
      baseUrl: 'http://127.0.0.1:12345/',
      fetchImpl: async () => {
        calls += 1;
        return new Response(new ReadableStream({
          pull(controller) { reads += 1; controller.enqueue(chunk); },
          cancel() { canceled = true; },
        }, { highWaterMark: 0 }), { headers: responseHeaders });
      },
    });
    await assert.rejects(() => client.checkout('market', { total: 10 }), error =>
      error instanceof ApiError && error.ambiguous === true && error.status === 200 && /size limit/.test(error.message));
    assert.equal(calls, 1);
    assert.equal(reads, 21);
    assert.equal(canceled, true);
  }
});

test('streamed JSON accepts the exact response limit and split UTF-8 characters', async () => {
  const limit = 20 * 1024 * 1024;
  const prefix = new Uint8Array(limit - 4).fill(32);
  prefix[0] = 34;
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(prefix);
        controller.enqueue(new Uint8Array([0xe2]));
        controller.enqueue(new Uint8Array([0x82, 0xac, 34]));
        controller.close();
      },
    })),
  });
  const result = await client.auth();
  assert.equal(result, `${' '.repeat(limit - 5)}€`);
});

test('redirect responses are rejected without following or exposing the location', async () => {
  let calls = 0;
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.redirect, 'error');
      return new Response(null, { status: 307, headers: { location: 'https://other.example/?token=private-value' } });
    },
  });
  await assert.rejects(() => client.checkout('market', { total: 10 }), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.ambiguous, true);
    assert.equal(error.status, 307);
    assert.match(error.message, /POST \/api\/ms\/shopping-cart-proxy\/market\/checkout \(HTTP 307\)/);
    assert.equal(error.message.includes('private-value'), false);
    assert.equal(error.message.includes('other.example'), false);
    return true;
  });
  assert.equal(calls, 1);
});

test('checkout component identifiers cannot become null or rounded numbers', () => {
  let calls = 0;
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async () => { calls += 1; return response({}); },
  });
  for (const ids of [null, [], Array(1), [undefined], ['store-a'], ['1_2'], ['1e3'], ['-1'], ['0'], ['9007199254740993'], [9007199254740992], [true]]) {
    assert.throws(() => client.checkoutComponents('market', ids), ApiError);
  }
  assert.equal(calls, 0);
});

test('identifier validation rejects rounded numeric identifiers while preserving exact strings', async () => {
  const calls = [];
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async url => { calls.push(String(url)); return response({}); },
  });
  assert.throws(() => client.tipSegmentation('market', 9007199254740992), ApiError);
  assert.throws(() => client.tipSegmentation('market', true), ApiError);
  await client.tipSegmentation('market', '9007199254740993');
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0]).searchParams.get('store_id'), '9007199254740993');
});

test('search does not invent free delivery, zero minimum or zero stock when metadata is missing', async () => {
  const client = new RappiClient(headers, {
    baseUrl: 'http://127.0.0.1:12345/',
    fetchImpl: async url => url.pathname.endsWith('/addresses')
      ? response([{ id: 7, active: true, lat: 0, lng: 0 }])
      : response({ stores: [{
        store_id: 10, products: [{ id: '10_a', name: 'Fixture product', stock: null }],
      }] }),
  });
  const { results: [product] } = await client.search('Fixture product');
  assert.equal(product.price, null);
  assert.equal(product.real_price, null);
  assert.equal(product.shipping_cost, null);
  assert.equal(product.minimum_order, null);
  assert.equal(product.stock, null);
});
