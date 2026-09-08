import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const optimizer = fileURLToPath(new URL('../skills/rappi-ordering/scripts/optimize-basket.mjs', import.meta.url));

function candidate(storeId, itemId, unitPrice, minimumOrder) {
  return {
    store_id: storeId,
    store_name: `Store ${storeId}`,
    product_id: `${storeId}_${itemId}`,
    product_name: `Product ${itemId}`,
    unit_price: unitPrice,
    minimum_order: minimumOrder,
    available: true,
  };
}

test('optimizer finds the cheapest feasible split while respecting store minimums', () => {
  const input = {
    max_stores: 2,
    items: [
      { id: 'one', quantity: 1, candidates: [candidate('a', 'one', 4, 8), candidate('b', 'one', 20, 10)] },
      { id: 'two', quantity: 1, candidates: [candidate('a', 'two', 4, 8), candidate('b', 'two', 20, 10)] },
      { id: 'three', quantity: 1, candidates: [candidate('a', 'three', 20, 8), candidate('b', 'three', 5, 10)] },
      { id: 'four', quantity: 1, candidates: [candidate('a', 'four', 20, 8), candidate('b', 'four', 5, 10)] },
    ],
  };
  const run = spawnSync(process.execPath, [optimizer], {
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.best_overall.total, 18);
  assert.equal(result.best_overall.store_count, 2);
  assert.equal(result.best_single_store.total, 48);
  assert.equal(result.split_savings, 30);
  assert.deepEqual(result.best_overall.stores.map(store => [store.store_id, store.item_subtotal]), [
    ['a', 8],
    ['b', 10],
  ]);
});
