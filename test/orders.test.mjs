import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOrderIds, reconcileOrders, summarizeSubmissionError } from '../src/commands.mjs';

test('collects checkout order IDs without treating nested product IDs as orders', () => {
  const ids = [...collectOrderIds({ orders: [{ orderId: 11 }, { order_id: '12', products: [{ id: 999 }] }] })];
  assert.deepEqual(ids.sort(), ['11', '12']);
});

test('submission errors expose only sanitized diagnostic fields', () => {
  const summary = summarizeSubmissionError({
    status: 400,
    payload: {
      code: 'payment_declined\u0000',
      message: 'Payment could not be processed.\u001b[31m',
      payment_method_token: 'secret-token',
    },
  });
  assert.deepEqual(summary, {
    status: 400,
    code: 'payment_declined',
    message: 'Payment could not be processed. [31m',
  });
  assert.equal(JSON.stringify(summary).includes('secret-token'), false);
});

test('reconciliation requires every order, store, and approved amount', async () => {
  const snapshot = { stores: [
    { id: '1', final_total_centavos: 1200 },
    { id: '2', final_total_centavos: 800 },
  ] };
  const good = { ordersRaw: async () => ({ orders: [
    { order_id: 'a', store_id: '1', total: 12, status: 'created' },
    { order_id: 'b', store_id: '2', total: 8, status: 'created' },
  ] }) };
  assert.equal((await reconcileOrders(good, ['a', 'b'], snapshot, { attempts: 1, intervalMs: 0 })).confirmed, true);

  const wrongAmount = { ordersRaw: async () => ({ orders: [
    { order_id: 'a', store_id: '1', total: 12, status: 'created' },
    { order_id: 'b', store_id: '2', total: 8.01, status: 'created' },
  ] }) };
  assert.equal((await reconcileOrders(wrongAmount, ['a', 'b'], snapshot, { attempts: 1, intervalMs: 0 })).confirmed, false);
});

test('recognizes explicit order containers but not unrelated IDs', () => {
  assert.deepEqual([...collectOrderIds({ data: { orders: [{ id: 11 }], order_ids: [12] }, id: 999, products: [{ order_id: 888 }] })], ['11', '12']);
});

test('polls delayed orders after checkout without IDs without claiming a financial match', async () => {
  let reads = 0;
  const client = { ordersRaw: async () => {
    reads += 1;
    if (reads === 1) throw new Error('temporary read failure');
    if (reads === 2) return { cards: [] };
    return { cards: [
      { order_id: 'old', state: 'created', store_type_store: 'retailer-fixture' },
      { order_id: 'new', state: 'created', store_type_store: 'retailer-fixture' },
    ] };
  } };
  const result = await reconcileOrders(client, [], { stores: [{ id: '1', final_total_centavos: 4651 }] }, {
    attempts: 3, intervalMs: 0, beforeOrderIds: ['old'], allowDiscovery: true,
  });
  assert.equal(reads, 3);
  assert.equal(result.confirmed, false);
  assert.equal(result.placement_observed, false);
  assert.equal(result.read_failures, 1);
  assert.deepEqual(result.candidate_orders.map(order => order.order_id), ['new']);
});

test('reports returned order as observed even when listing lacks financial details', async () => {
  const result = await reconcileOrders({
    ordersRaw: async () => ({ cards: [{ order_id: 'new', state: 'created' }] }),
  }, ['new'], { stores: [{ id: '1', final_total_centavos: 4651 }] }, { attempts: 1, intervalMs: 0 });
  assert.equal(result.confirmed, false);
  assert.equal(result.placement_observed, true);
  assert.equal(result.orders[0].order_id, 'new');
  assert.equal(result.orders[0].total, null);
});
