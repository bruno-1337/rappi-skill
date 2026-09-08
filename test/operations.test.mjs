import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSearchOptions, rankSearch, buildCartMutation, verifyCartMutation,
  summarizeCarts, buildCheckoutSnapshot, selectCartCandidate, selectCheckoutStores,
  summarizePaymentMethods, buildPaymentSelection, resolveSelectedPayment, summarizeOrders,
} from '../src/operations.mjs';

const baseProduct = {
  cart_type: 'market', minimum_order: 15, closed: false, available: true, stock: 5,
  presentation: '473 mL', real_price: 10, sale_type: 'U', minimum_units: 1,
  eta: { maximum_minutes: 30 }, age_restriction: false, requires_prescription: false,
};

const currentPaymentContext = {
  storeType: 'turbo',
  cartPayload: [{
    store_type: 'turbo', stores: [],
    payment_method: {
      rappi_credit: { use_rappi_credit: true },
      rappi_pay: { use_rappi_pay: false, rappi_pay_method_active: false },
    },
  }],
};

test('search excludes unrelated API suggestions and ranks selected mode', () => {
  const payload = { query: 'Monster Energy', results: [
    { ...baseProduct, store_id: '1', product_id: 'a', store_name: 'Turbo', name: 'Monster Energético Original', description: 'Bebida energética sabor original.', ean: '1', price: 10 },
    { ...baseProduct, store_id: '2', product_id: 'b', store_name: 'Other', name: 'Red Bull Energy', ean: '2', price: 1, eta: { maximum_minutes: 5 } },
    { ...baseProduct, store_id: '3', product_id: 'c', store_name: 'Fast', name: 'Monster Mango', ean: '3', price: 11, eta: { maximum_minutes: 10 } },
  ] };
  const options = parseSearchOptions(['Monster', 'Energy', '--sort', 'fastest', '--limit', '10']);
  const ranked = rankSearch(payload, options);
  assert.deepEqual(ranked.results.map(row => row.product_id), ['c', 'a']);
  assert.equal(ranked.results.find(row => row.product_id === 'a').description, 'Bebida energética sabor original.');
});

test('search keeps an individual listing ahead of a minimum-meeting pack and offers a separate two-unit basket', () => {
  const payload = { query: 'Spark Drink', carts: [{
    store_type: 'market',
    stores: [{ id: 'fixture', products: [{ id: 'existing', units: 1, price: 100 }] }],
  }], results: [
    { ...baseProduct, store_id: 'fixture', product_id: 'pack', name: '4 x Spark Drink', presentation: '4 X 473 mL', price: 41.16, shipping_cost: 6.99 },
    { ...baseProduct, store_id: 'fixture', product_id: 'single', name: 'Spark Drink', price: 10.29, shipping_cost: 6.99 },
  ] };
  const ranked = rankSearch(payload, parseSearchOptions(['Spark', 'Drink']));
  assert.equal(ranked.estimates_scope, 'isolated_basket');
  assert.deepEqual(ranked.results.map(row => row.product_id), ['single', 'pack']);
  const [single, pack] = ranked.results;
  assert.deepEqual(single.requested, {
    units: 1, item_subtotal: 10.29, estimated_delivered: 17.28, minimum_shortfall: 4.71, feasible: false,
  });
  assert.deepEqual(single.alternative, {
    units: 2, item_subtotal: 20.58, estimated_delivered: 27.57, requires_confirmation: true,
  });
  assert.equal(single.quantity, 1);
  assert.deepEqual(pack.packaging, { status: 'multiple_indicated', title_units: 4, presentation_units: 4 });
  assert.equal(pack.requested.units, 1);
  assert.equal(pack.requested.item_subtotal, 41.16);
  assert.equal(pack.alternative, null);
});

test('delivered search compares the least feasible basket instead of hiding low-minimum stores behind cheap units', () => {
  const payload = { query: 'Spark', results: [
    { ...baseProduct, store_id: 'high-minimum', product_id: 'cheap-unit', name: 'Spark', price: 8.7, minimum_order: 100, stock: 20, shipping_cost: 0 },
    { ...baseProduct, store_id: 'low-minimum', product_id: 'two-units', name: 'Spark', price: 10.29, minimum_order: 15, stock: 5, shipping_cost: 0 },
    { ...baseProduct, store_id: 'sold-short', product_id: 'insufficient-stock', name: 'Spark', price: 7, minimum_order: 100, stock: 1, shipping_cost: 0 },
  ] };
  const delivered = rankSearch(payload, parseSearchOptions(['Spark'])).results;
  assert.deepEqual(delivered.map(row => row.product_id), ['two-units', 'cheap-unit', 'insufficient-stock']);
  assert.equal(delivered[0].requested.units, 1);
  assert.equal(delivered[0].requested.feasible, false);
  assert.equal(delivered[0].alternative.units, 2);
  assert.equal(delivered[0].alternative.item_subtotal, 20.58);
  const byPrice = rankSearch(payload, parseSearchOptions(['Spark', '--sort', 'price'])).results;
  assert.deepEqual(byPrice.map(row => row.product_id), ['insufficient-stock', 'cheap-unit', 'two-units']);
});

test('search does not offer unstocked alternatives and distinguishes unknown stock from insufficient stock', () => {
  const payload = { query: 'Spark', results: [
    { ...baseProduct, store_id: 'fixture', product_id: 'limited', name: 'Spark', price: 10.29, shipping_cost: 0, stock: 1 },
    { ...baseProduct, store_id: 'fixture', product_id: 'unknown', name: 'Spark', price: 10.29, shipping_cost: 0, stock: null },
  ] };
  const one = rankSearch(payload, parseSearchOptions(['Spark'])).results;
  assert.deepEqual(one.map(row => row.alternative), [null, null]);
  const two = rankSearch(payload, parseSearchOptions(['Spark', '--quantity', '2'])).results;
  assert.deepEqual(two.map(row => [row.product_id, row.requested.feasible]), [['limited', false], ['unknown', null]]);
});

test('search respects minimum listing units and leaves an exact request unchanged', () => {
  const payload = { query: 'Spark', results: [{
    ...baseProduct, store_id: 'fixture', product_id: 'single', name: 'Spark',
    price: 0.29, shipping_cost: 0.02, minimum_order: 0.87, minimum_units: 4,
  }] };
  const requested = rankSearch(payload, parseSearchOptions(['Spark', '--quantity', '3'])).results[0];
  assert.deepEqual(requested.requested, {
    units: 3, item_subtotal: 0.87, estimated_delivered: 0.89, minimum_shortfall: 0, feasible: false,
  });
  assert.deepEqual(requested.alternative, {
    units: 4, item_subtotal: 1.16, estimated_delivered: 1.18, requires_confirmation: true,
  });
  assert.equal(requested.quantity, 3);
  const exact = rankSearch(payload, parseSearchOptions(['Spark', '--quantity', '4'])).results[0];
  assert.equal(exact.quantity, 4);
  assert.equal(exact.requested.units, 4);
  assert.equal(exact.requested.feasible, true);
  assert.equal(exact.alternative, null);
});

test('search exposes contradictory packaging rather than treating size or title counts as proof', () => {
  const payload = { query: 'Spark', results: [
    { ...baseProduct, store_id: 'fixture', product_id: 'conflict', name: '4 x Spark', presentation: '1 X 473 mL', price: 1 },
    { ...baseProduct, store_id: 'fixture', product_id: 'unknown', name: 'Spark', presentation: '473', price: 2 },
    { ...baseProduct, store_id: 'fixture', product_id: 'single', name: 'Spark', presentation: '473 mL', price: 10.29 },
  ] };
  const rows = rankSearch(payload, parseSearchOptions(['Spark', '--sort', 'price'])).results;
  assert.deepEqual(rows.map(row => row.product_id), ['single', 'unknown', 'conflict']);
  assert.deepEqual(rows.map(row => row.packaging), [
    { status: 'single_indicated', title_units: null, presentation_units: 1 },
    { status: 'unknown', title_units: null, presentation_units: null },
    { status: 'conflicting', title_units: 4, presentation_units: 1 },
  ]);
  assert.equal(rows[2].requested.units, 1);
});

test('search only changes pack preference for an explicit multipack query, not a requested item count', () => {
  const results = [
    { ...baseProduct, store_id: 'fixture', product_id: 'single', name: 'Spark', price: 10.29 },
    { ...baseProduct, store_id: 'fixture', product_id: 'pack', name: 'Pack 4 Spark', presentation: '4 X 473 mL', price: 41.16 },
  ];
  const pack = rankSearch({ query: 'Spark pack', results }, parseSearchOptions(['Spark', 'pack']));
  assert.deepEqual(pack.results.map(row => row.product_id), ['pack', 'single']);
  const two = rankSearch({ query: 'Spark 2 unidades', results }, parseSearchOptions(['Spark', '2', 'unidades', '--quantity', '2']));
  assert.deepEqual(two.results.map(row => row.product_id), ['single', 'pack']);
});

test('search does not claim feasibility or suggest extra regulated or weighted listing units', () => {
  const variants = [
    { product_id: 'age-restricted', age_restriction: true },
    { product_id: 'prescription', requires_prescription: true },
    { product_id: 'weighted', sale_type: 'P' },
    { product_id: 'unknown-sale-type', sale_type: null },
  ];
  const payload = { query: 'Spark', results: variants.map(variant => ({
    ...baseProduct, store_id: 'fixture', name: 'Spark', price: 10.29, shipping_cost: 0, ...variant,
  })) };
  const one = rankSearch(payload, parseSearchOptions(['Spark'])).results;
  assert.deepEqual(one.map(row => row.alternative), [null, null, null, null]);
  const two = rankSearch(payload, parseSearchOptions(['Spark', '--quantity', '2'])).results;
  assert.deepEqual(two.map(row => row.requested.feasible), [null, null, null, null]);
});

test('search keeps unknown purchasing metadata uncertain and folds store closure into availability', () => {
  const variants = [
    { product_id: 'unknown-minimum', minimum_order: null },
    { product_id: 'unknown-unit-rule', minimum_units: null },
    { product_id: 'unknown-availability', available: null },
    { product_id: 'closed', closed: true },
    { product_id: 'unknown-price', price: null },
  ];
  const payload = { query: 'Spark', results: variants.map(variant => ({
    ...baseProduct, store_id: 'fixture', name: 'Spark', price: 10.29, shipping_cost: 0, ...variant,
  })) };
  const rows = rankSearch(payload, parseSearchOptions(['Spark', '--quantity', '2', '--include-unavailable'])).results;
  const decisions = Object.fromEntries(rows.map(row => [row.product_id, row.requested.feasible]));
  assert.deepEqual(decisions, {
    'unknown-minimum': null, 'unknown-unit-rule': null, 'unknown-availability': null, closed: false, 'unknown-price': null,
  });
  assert.equal(rows.find(row => row.product_id === 'closed').available, false);
  assert.equal(rows.find(row => row.product_id === 'unknown-price').requested.estimated_delivered, null);
  assert.throws(() => selectCartCandidate(rows, { storeType: 'market', storeId: 'fixture', productId: 'closed' }), /not currently available/);
  const available = rankSearch(payload, parseSearchOptions(['Spark', '--quantity', '2'])).results;
  assert.deepEqual(available.map(row => row.product_id), ['unknown-minimum', 'unknown-unit-rule', 'unknown-price']);
});

test('cart mutation preserves existing fields and verifies readback', () => {
  const before = [{ store_type: 'market', stores: [{ id: 10, opaque: 'keep', products: [{ id: '10_old', units: 2, sale_type: 'U', comment: 'keep' }] }] }];
  const updated = buildCartMutation(before, { storeType: 'market', storeId: '10', product: { id: '10_new', sale_type: 'U' }, units: 3 });
  assert.equal(updated[0].opaque, 'keep');
  assert.equal(updated[0].products[0].comment, 'keep');
  assert.equal(updated[0].products[1].units, 3);
  const response = [{ store_type: 'market', stores: updated }];
  assert.equal(verifyCartMutation(response, { storeId: '10', productId: '10_new', units: 3 }).stores[0].products[1].units, 3);
  const removed = buildCartMutation(response, { storeType: 'market', storeId: '10', product: { id: '10_new' }, units: 0 });
  assert.equal(removed[0].products.some(row => row.id === '10_new'), false);
});

test('cart refuses ambiguous response shapes', () => {
  assert.throws(() => summarizeCarts({ surprise: [] }), /invalid shape/);
});


test('cart refuses recognized wrappers containing unknown groups', () => {
  assert.throws(() => buildCartMutation({ data: [{ unexpected: [] }] }, {
    storeType: 'market', storeId: '10', product: { id: '10_a', sale_type: 'U' }, units: 1,
  }), /unrecognized group/);
});


test('direct cart groups without cart type fail closed for mutation', () => {
  assert.throws(() => buildCartMutation([{ id: 10, products: [] }], {
    storeType: 'market', storeId: '10', product: { id: '10_a', sale_type: 'U' }, units: 1,
  }), /declare their cart type/);
});
test('cart candidate must match the selected cart type', () => {
  const candidate = { store_id: '10', product_id: '10_a', cart_type: 'turbo', available: true, closed: false };
  assert.throws(() => selectCartCandidate([candidate], {
    storeType: 'market', storeId: '10', productId: '10_a',
  }), /cart type/);
});
test('checkout does not infer market from a single retailer cart', () => {
  const cart = summarizeCarts([{
    store_type: 'retailer-fixture',
    stores: [{ id: 10, products: [{ id: '10_a', units: 1 }] }],
  }]);
  assert.deepEqual(selectCheckoutStores(cart, 'market'), []);
  assert.deepEqual(selectCheckoutStores(cart, 'retailer-fixture').map(store => store.store_id), ['10']);
});
test('checkout snapshot binds per-store totals and material choices', () => {
  const snapshot = buildCheckoutSnapshot({
    storeType: 'market',
    cartSummary: { stores: [{ store_id: '10', products: [{ product_id: '10_a', units: 1 }] }] },
    recalculation: { final_total: 17.49 },
    summary: { item_subtotal: 10.5, discount_total: 0, delivery_total: 6.99, service_fee_total: 0 },
    detail: { payment_method_id: 'card-fixture', payment_method_label: 'Fixture card' },
    components: { delivery_window: 'now' },
    address: { id: '7', label: 'Saved address' },
  });
  assert.equal(snapshot.final_total_centavos, 1749);
  assert.equal(snapshot.stores[0].final_total_centavos, 1749);
  assert.equal(snapshot.payment_method_id, 'card-fixture');
  assert.equal(snapshot.address_label, 'Saved address');
});

test('checkout snapshot parses typed summary rows from current Rappi shape', () => {
  const snapshot = buildCheckoutSnapshot({
    storeType: 'turbo',
    cartSummary: { stores: [{ store_id: '10', products: [{ product_id: '10_a', units: 2, unit_price: 10.29 }] }] },
    recalculation: { total: 32.57, product_total: 20.58, shipping_total: 6.99, tip: 2 },
    summary: { summary: [{ sub_value: [
      { type: 'product_total', raw_value: '20.58' },
      { type: 'shipping', raw_value: '6.99' },
      { type: 'service_fee', raw_value: '3.0' },
      { type: 'tip', raw_value: '2.0' },
    ] }] },
    detail: {},
    components: {},
    address: { id: '7', label: 'Saved address' },
  });
  assert.deepEqual({
    subtotal: snapshot.item_subtotal_centavos,
    delivery: snapshot.delivery_total_centavos,
    service: snapshot.service_fee_total_centavos,
    tip: snapshot.tip_centavos,
    mandatory: snapshot.mandatory_charges_total_centavos,
    total: snapshot.final_total_centavos,
  }, { subtotal: 2058, delivery: 699, service: 300, tip: 200, mandatory: 0, total: 3257 });
});

test('saved-card selection uses exact alias and keeps secrets out of summaries', () => {
  const response = {
    payment_methods: [{ id: 'cc', description: 'Cartão', available: true }],
    list_cards: [{
      alias: 'primary-card', card_brand: 'VISA', card_class: 'CREDIT', last_four_digits: '7890',
      available: true, blocked: false, default_cc: true,
      charge_data: {
        account_payment_id: 'account-fixture', card_class: 'CREDIT', card_type: 'visa',
        first_six_digits: '123456', last_four_digits: '7890', payment_method: 'cc',
        payment_method_token: 'token-fixture', store_ids: '10', store_type: 'turbo',
        online_payment: 'true', payment_method_description: 'masked',
      },
    }],
  };
  const listed = summarizePaymentMethods(response);
  assert.equal(JSON.stringify(listed).includes('token-fixture'), false);
  assert.equal(listed.cards[0].alias, 'primary-card');
  const selected = buildPaymentSelection(response, 'PRIMARY-CARD', currentPaymentContext);
  assert.equal(selected.payload.payment_method_type, 'cc');
  assert.equal(selected.payload.card.card_reference, 'account-fixture');
  assert.equal(selected.payload.charge_data.payment_method_token, 'token-fixture');
  assert.equal(selected.selection.payment_method_label, 'primary-card — VISA •••• 7890');
  assert.deepEqual(selected.payload.rappi_credit, { use_rappi_credit: true });
  assert.deepEqual(selected.payload.rappi_pay, { use_rappi_pay: false, rappi_pay_method_active: false });
  const unavailable = structuredClone(response);
  unavailable.payment_methods[0].available = false;
  assert.throws(() => buildPaymentSelection(unavailable, 'primary-card', currentPaymentContext), /not currently available/);
  const unknownBalances = structuredClone(currentPaymentContext);
  unknownBalances.cartPayload[0].payment_method.rappi_credit.use_rappi_credit = null;
  assert.throws(() => buildPaymentSelection(response, 'primary-card', unknownBalances), /cannot be verified/);
  assert.throws(() => buildPaymentSelection(response, 'primary-card', {
    ...currentPaymentContext, storeType: 'market',
  }), /matching cart group/);
  const resolved = resolveSelectedPayment([{
    store_type: 'turbo',
    stores: [],
    payment_method: { payment_method_type: 'cc', card: { card_reference: 'account-fixture' } },
  }], 'turbo', response);
  assert.deepEqual(resolved, {
    payment_method_id: 'cc|account-fixture',
    payment_method_label: 'primary-card — VISA •••• 7890',
  });
});

test('multi-store snapshot refuses missing per-store totals', () => {
  assert.throws(() => buildCheckoutSnapshot({
    storeType: 'market',
    cartSummary: { stores: [
      { store_id: '10', products: [{ product_id: '10_a', units: 1 }] },
      { store_id: '20', products: [{ product_id: '20_b', units: 1 }] },
    ] },
    recalculation: { final_total: 20 },
    summary: { item_subtotal: 20 },
    detail: { payment_method_id: 'card-fixture' },
    components: {},
    address: { id: '7', label: 'Saved address' },
  }), /verifiable totals/);
});

test('multi-store snapshot requires per-store totals to equal aggregate', () => {
  assert.throws(() => buildCheckoutSnapshot({
    storeType: 'market',
    cartSummary: { stores: [
      { store_id: '10', products: [{ product_id: '10_a', units: 1 }] },
      { store_id: '20', products: [{ product_id: '20_b', units: 1 }] },
    ] },
    recalculation: {
      final_total: 20,
      stores: [
        { store_id: 10, total: 12, subtotal: 12 },
        { store_id: 20, total: 9, subtotal: 8 },
      ],
    },
    summary: { item_subtotal: 20 },
    detail: { payment_method_id: 'card-fixture' },
    components: {},
    address: { id: '7', label: 'Saved address' },
  }), /does not equal/);
});

test('payment resolution does not borrow a single unrelated retailer selection', () => {
  const selected = resolveSelectedPayment([{
    store_type: 'pharmacy-fixture', stores: [],
    payment_method: { payment_method_type: 'cash' },
  }], 'market', { payment_methods: [{ id: 'cash', available: true }] });
  assert.equal(selected.payment_method_id, 'unresolved');
});

test('cart mutation rejects untyped nested groups and ambiguous or mixed groups', () => {
  const request = { storeType: 'market', storeId: '10', product: { id: '10_a' }, units: 1 };
  assert.throws(() => buildCartMutation([{ stores: [{ id: 10, products: [] }] }], request), /declare their cart type/);
  assert.throws(() => buildCartMutation([
    { store_type: 'market', stores: [{ id: 10, products: [] }] },
    { store_type: 'market', stores: [{ id: 20, products: [] }] },
  ], request), /ambiguous groups/);
  assert.throws(() => buildCartMutation([
    { store_type: 'market', stores: [] },
    { store_type: 'turbo', id: 20, products: [] },
  ], request), /incompatible group shapes/);
  assert.throws(() => buildCartMutation([
    { store_type: 'retailer-fixture', stores: [{ id: 10, products: [] }] },
  ], request), /refusing to infer/);
  assert.throws(() => buildCartMutation([], { ...request, units: null }), /units must be an integer/);
});

test('cart shape validation rejects invalid identities and quantities', () => {
  assert.throws(() => summarizeCarts([{ store_type: 'market', stores: [
    { id: null, products: [] },
  ] }]), /unrecognized group/);
  assert.throws(() => summarizeCarts([{ store_type: 'market', stores: [
    { id: 10, products: [{ id: '10_a', units: null }] },
  ] }]), /unrecognized group/);
  assert.throws(() => summarizeCarts([{ store_type: 'market', stores: [
    { id: 10, products: [{ id: '10_a', units: 1 }, { id: '10_a', units: 2 }] },
  ] }]), /unrecognized group/);
});

test('cart readback is bound to the requested type rather than only store ID', () => {
  const payload = [{ store_type: 'turbo', stores: [{ id: 10, products: [{ id: '10_a', units: 1 }] }] }];
  const request = { storeType: 'market', storeId: '10', productId: '10_a', units: 1 };
  assert.throws(() => verifyCartMutation(payload, request), /does not match/);
  assert.equal(verifyCartMutation(payload, { ...request, storeType: 'turbo' }).stores[0].products[0].units, 1);
  assert.throws(() => verifyCartMutation([{ stores: payload[0].stores }], { ...request, units: 0 }), /declare its cart type/);
});

test('order cards expose only known identity, type, dates and monetary values', () => {
  const result = summarizeOrders({ cards: [{
    order_id: 42, state: 'delivered', store_type_store: 'pharmacy-fixture', store_type_group: 'market',
    created_at: '2026-09-01', updated_at: '2026-09-02', total: null,
    texts: [{ text: 'Private delivery details' }],
  }] });
  assert.deepEqual(result, { order_count: 1, orders: [{
    order_id: '42', status: 'delivered', store_id: null, store_name: '',
    store_type: 'pharmacy-fixture', store_type_group: 'market', total: null,
    created_at: '2026-09-01', updated_at: '2026-09-02',
  }] });
  assert.equal(summarizeOrders([{ id: 1, total: 0 }]).orders[0].total, 0);
  assert.equal(summarizeOrders([{ id: 1, amount: '12.50' }]).orders[0].total, 12.5);
  assert.equal(summarizeOrders([{ id: 1, total: false }]).orders[0].total, null);
});

test('orders reject unknown wrappers and rows rather than reporting no orders', () => {
  assert.throws(() => summarizeOrders({ unexpected: [] }), /invalid shape/);
  assert.throws(() => summarizeOrders({ data: { cards: [] } }), /invalid shape/);
  assert.throws(() => summarizeOrders({ cards: [{}] }), /unrecognized order shape/);
  assert.throws(() => summarizeOrders({ orders: [null] }), /order must be an object/);
  assert.deepEqual(summarizeOrders({ cards: [] }), { order_count: 0, orders: [] });
});

test('checkout rejects null totals and null typed or direct monetary amounts', () => {
  const input = {
    storeType: 'market',
    cartSummary: { stores: [{ store_id: '10', products: [{ product_id: '10_a', units: 1, unit_price: 10 }] }] },
    recalculation: { final_total: 10 },
    summary: {}, detail: {}, components: {}, address: { id: '7' },
  };
  assert.throws(() => buildCheckoutSnapshot({ ...input, recalculation: { final_total: null } }), /valid monetary amount/);
  assert.throws(() => buildCheckoutSnapshot({ ...input, summary: { delivery_total: null } }), /valid monetary amount/);
  assert.throws(() => buildCheckoutSnapshot({ ...input, summary: [
    { type: 'product_total', raw_value: null },
  ] }), /invalid monetary amount/);
  assert.throws(() => buildCheckoutSnapshot({
    ...input,
    cartSummary: { stores: [
      ...input.cartSummary.stores,
      { store_id: '20', products: [{ product_id: '20_b', units: 1, unit_price: 10 }] },
    ] },
    recalculation: { final_total: 20, stores: [
      { store_id: 10, total: null, subtotal: 10 },
      { store_id: 20, total: 10, subtotal: 10 },
    ] },
  }), /valid monetary amount/);
  const unknownPrice = summarizeCarts([{ store_type: 'market', stores: [
    { id: 10, products: [{ id: '10_a', units: 1, price: null }] },
  ] }]);
  assert.equal(unknownPrice.stores[0].products[0].unit_price, null);
  assert.throws(() => buildCheckoutSnapshot({ ...input, cartSummary: unknownPrice }), /subtotal cannot be verified/);
});
