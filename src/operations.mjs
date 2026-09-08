import { ApiError, cleanRemote, moneyToCents } from './api.mjs';

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(`${label} must be an object.`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new ApiError(`${label} must be an array.`);
  return value;
}

function finiteNumber(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validId(value) {
  return (typeof value === 'string' && value.trim().length > 0)
    || (typeof value === 'number' && Number.isSafeInteger(value));
}

function cartType(group) {
  const type = group.store_type ?? group.type;
  return typeof type === 'string' && type.trim() === type ? type : '';
}

function clone(value) {
  return structuredClone(value);
}

export function parsePositiveInteger(value, label, maximum = 10_000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new ApiError(`${label} must be an integer from 1 to ${maximum}.`);
  return number;
}

export function parseSearchOptions(args) {
  const options = { query: [], sort: 'delivered', limit: 20, quantity: 1, ean: null, available: true };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { options.query.push(token); continue; }
    const [name, inline] = token.split('=', 2);
    const take = () => inline ?? args[++index];
    if (name === '--sort') options.sort = take();
    else if (name === '--limit') options.limit = parsePositiveInteger(take(), 'limit', 100);
    else if (name === '--quantity') options.quantity = parsePositiveInteger(take(), 'quantity', 100);
    else if (name === '--ean') options.ean = String(take() ?? '').replace(/\D/g, '');
    else if (name === '--include-unavailable') options.available = false;
    else throw new ApiError(`Unknown search option: ${name}.`);
  }
  options.query = options.query.join(' ').trim();
  if (!['price', 'fastest', 'delivered'].includes(options.sort)) throw new ApiError('sort must be price, fastest, or delivered.');
  if (options.ean && !/^\d{8,14}$/.test(options.ean)) throw new ApiError('ean must contain 8-14 digits.');
  return options;
}

function fold(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function relevance(row, query) {
  const haystack = fold(`${row.name} ${row.presentation} ${row.ean}`);
  const normalized = fold(query).replace(/\s+/g, ' ').trim();
  const ignored = new Set(['para', 'com', 'sem', 'uma', 'uns', 'das', 'dos', 'the', 'and', 'energy', 'energetico', 'energetica']);
  const tokens = [...new Set(normalized.split(/[^a-z0-9]+/).filter(token => token.length >= 3 && !ignored.has(token)))];
  if (!tokens.length) return 1;
  const phrase = tokens.join(' ');
  const matches = tokens.filter(token => haystack.includes(token)).length;
  return (haystack.includes(phrase) ? 100 : 0) + matches * 10 + (matches === tokens.length ? 25 : 0);
}

export function rankSearch(searchPayload, options) {
  let rows = array(searchPayload.results, 'search.results');
  if (options.ean) rows = rows.filter(row => String(row.ean).replace(/\D/g, '') === options.ean);
  else rows = rows.map(row => ({ ...row, relevance: relevance(row, searchPayload.query) })).filter(row => row.relevance > 0);
  if (options.available) rows = rows.filter(row => row.available && !row.closed && row.stock !== 0);
  const deduped = [...new Map(rows.map(row => [`${row.store_id}|${row.product_id}`, row])).values()]
    .map(row => {
      const itemSubtotal = Number((row.price * options.quantity).toFixed(2));
      const estimatedDelivered = Number((itemSubtotal + row.shipping_cost).toFixed(2));
      return {
        ...row,
        quantity: options.quantity,
        item_subtotal: itemSubtotal,
        estimated_delivered: estimatedDelivered,
        minimum_shortfall: Number(Math.max(0, row.minimum_order - itemSubtotal).toFixed(2)),
      };
    });
  const eta = row => row.eta?.maximum_minutes ?? Number.POSITIVE_INFINITY;
  const comparator = options.sort === 'price'
    ? (a, b) => a.item_subtotal - b.item_subtotal || eta(a) - eta(b)
    : options.sort === 'fastest'
      ? (a, b) => eta(a) - eta(b) || a.estimated_delivered - b.estimated_delivered
      : (a, b) => (a.minimum_shortfall > 0) - (b.minimum_shortfall > 0) || a.estimated_delivered - b.estimated_delivered || eta(a) - eta(b);
  deduped.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0) || comparator(a, b));
  return {
    query: searchPayload.query,
    sort: options.sort,
    quantity: options.quantity,
    result_count: deduped.length,
    results: deduped.slice(0, options.limit),
  };
}

function extractCartGroups(payload) {
  let groups;
  if (Array.isArray(payload)) groups = payload;
  else if (Array.isArray(payload?.carts)) groups = payload.carts;
  else if (Array.isArray(payload?.data)) groups = payload.data;
  else if (Array.isArray(payload?.data?.carts)) groups = payload.data.carts;
  else throw new ApiError('Cart response has an invalid shape.');
  if (groups.some(group => !recognizedCartGroup(group))) throw new ApiError('Cart response contains an unrecognized group shape.');
  return groups;
}

function recognizedStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)
    || !validId(store.id ?? store.store_id) || !Array.isArray(store.products)) return false;
  const ids = new Set();
  return store.products.every(product => {
    if (!product || typeof product !== 'object' || Array.isArray(product)
      || !validId(product.id ?? product.product_id)) return false;
    const id = String(product.id ?? product.product_id);
    const units = finiteNumber(product.units ?? product.quantity);
    if (ids.has(id) || !Number.isSafeInteger(units) || units < 0) return false;
    ids.add(id);
    return true;
  });
}

function recognizedCartGroup(group) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
  if (!Array.isArray(group.stores)) return recognizedStore(group);
  const ids = new Set();
  return group.stores.every(store => {
    if (!recognizedStore(store)) return false;
    const id = String(store.id ?? store.store_id);
    if (ids.has(id) || (cartType(group) && cartType(store) && cartType(group) !== cartType(store))) return false;
    ids.add(id);
    return true;
  });
}

function groupStores(group) {
  if (Array.isArray(group?.stores)) return group.stores;
  if (group && ('id' in group || 'store_id' in group) && Array.isArray(group.products)) return [group];
  return [];
}

export function summarizeCarts(payload) {
  const groups = extractCartGroups(payload);
  const stores = [];
  for (const group of groups) {
    for (const store of groupStores(group)) {
      const products = Array.isArray(store.products) ? store.products : [];
      stores.push({
        store_type: cartType(group) || cartType(store),
        store_id: String(store.id ?? store.store_id ?? ''),
        store_name: cleanRemote(store.name ?? store.store_name ?? ''),
        products: products.map(product => ({
          product_id: String(product.id ?? product.product_id ?? ''),
          name: cleanRemote(product.name ?? product.description ?? ''),
          units: finiteNumber(product.units ?? product.quantity),
          unit_price: finiteNumber(product.price ?? product.unit_price),
          sale_type: cleanRemote(product.sale_type),
        })),

      });
  }
  }
  return { store_count: stores.length, stores };
}

export function selectCheckoutStores(cart, storeType) {
  object(cart, 'cart');
  const stores = array(cart.stores, 'cart stores');
  return stores.filter(store => store.store_type === storeType);
}

export function selectCartCandidate(results, { storeType, storeId, productId }) {
  const found = array(results, 'search results').find(row =>
    row.store_id === storeId
    && row.product_id === productId
    && row.cart_type === storeType
    && row.available
    && !row.closed
  );
  if (!found) throw new ApiError('The selected product is not currently available for that cart type and store.');
  return found;
}

export function summarizePaymentMethods(payload) {
  object(payload, 'payment methods');
  const methods = array(payload.payment_methods, 'payment_methods');
  const cards = array(payload.list_cards, 'list_cards').map(card => ({
    alias: cleanRemote(card.alias),
    brand: cleanRemote(card.card_brand ?? card.card_type),
    card_class: cleanRemote(card.card_class),
    last_four: cleanRemote(card.last_four_digits),
    available: Boolean(card.available) && !Boolean(card.blocked),
    selected_by_default: Boolean(card.default_cc),
    selectable_by_alias: Boolean(cleanRemote(card.alias)),
  }));
  return {
    cards,
    other_methods: methods
      .filter(method => method.id !== 'cc')
      .map(method => ({
        id: cleanRemote(method.id),
        label: cleanRemote(method.main_description ?? method.description),
        available: Boolean(method.available),
        selected_by_default: Boolean(method.default),
      })),
  };
}

export function buildPaymentSelection(payload, alias, { cartPayload, storeType } = {}) {
  object(payload, 'payment methods');
  const wanted = fold(alias).trim();
  if (!wanted) throw new ApiError('Payment alias is required.');
  const methods = array(payload.payment_methods, 'payment_methods').filter(method => method.id === 'cc');
  if (methods.length !== 1 || methods[0].available !== true) throw new ApiError('Saved-card payment is not currently available.');
  const groups = extractCartGroups(cartPayload).filter(group => cartType(group) === storeType);
  if (groups.length !== 1) throw new ApiError('Current payment must belong to exactly one matching cart group.');
  const currentPayment = object(groups[0].payment_method, 'current cart payment method');
  const credit = object(currentPayment.rappi_credit, 'current Rappi credit selection');
  const pay = object(currentPayment.rappi_pay, 'current Rappi Pay selection');
  if (typeof credit.use_rappi_credit !== 'boolean'
    || typeof pay.use_rappi_pay !== 'boolean'
    || typeof pay.rappi_pay_method_active !== 'boolean') {
    throw new ApiError('Current Rappi credit and Rappi Pay choices cannot be verified.');
  }
  const cards = array(payload.list_cards, 'list_cards');
  const matches = cards.filter(card => fold(card.alias).trim() === wanted);
  if (matches.length !== 1) throw new ApiError('Payment alias must identify exactly one saved card.');
  const card = matches[0];
  if (card.available !== true || card.blocked) throw new ApiError('Selected saved card is not currently available.');
  if (card.need_verification || card.show_verification || card.requires_cvv || card.request_new_cvv) {
    throw new ApiError('Selected saved card requires interactive verification and cannot be selected by the CLI.');
  }
  const charge = object(card.charge_data, 'saved card charge_data');
  const accountId = String(charge.account_payment_id ?? '').trim();
  if (!accountId || charge.payment_method !== 'cc' || typeof charge.payment_method_token !== 'string' || !charge.payment_method_token.trim()) {
    throw new ApiError('Saved card lacks required payment metadata.');
  }
  const allowed = [
    'account_payment_id', 'card_class', 'card_type', 'currency_code_options',
    'first_six_digits', 'last_four_digits', 'local_currency_code',
    'payment_method_token', 'store_ids', 'store_type', 'threeds_reference_id',
    'transaction_type_desc', 'selected_installments', 'three_ds', 'language',
    'tags', 'document', 'online_payment', 'payment_method',
    'payment_method_description', 'payment_method_icon',
    'user_default_refund_payment_method', 'is_cvv_dynamic', 'fx_currency_code',
    'support_close_order_tip',
  ];
  const chargeData = {};
  for (const key of allowed) if (charge[key] != null) chargeData[key] = clone(charge[key]);
  chargeData.user_id = accountId;
  chargeData.origin_platform = 'web';
  return {
    payload: {
      card: { card_reference: accountId },
      payment_method_type: String(charge.payment_method),
      rappi_credit: clone(credit),
      rappi_pay: clone(pay),
      charge_data: chargeData,
    },
    selection: {
      payment_method_id: `${charge.payment_method}|${accountId}`,
      payment_method_label: `${cleanRemote(card.alias)} — ${cleanRemote(card.card_brand ?? card.card_type)} •••• ${cleanRemote(card.last_four_digits)}`,
    },
  };
}

export function resolveSelectedPayment(cartPayload, storeType, paymentPayload) {
  const groups = extractCartGroups(cartPayload);
  const matches = groups.filter(entry => cartType(entry) === storeType);
  if (matches.length > 1) throw new ApiError('Cart response contains ambiguous payment selections for the cart type.');
  const [group] = matches;
  const selected = group?.payment_method;
  if (!selected || typeof selected !== 'object') return { payment_method_id: 'unresolved', payment_method_label: 'Não selecionado' };
  const type = cleanRemote(selected.payment_method_type);
  if (!type) return { payment_method_id: 'unresolved', payment_method_label: 'Não selecionado' };
  if (type === 'cc') {
    const accountId = String(selected.card?.card_reference ?? selected.charge_data?.account_payment_id ?? '').trim();
    const cards = array(paymentPayload?.list_cards, 'list_cards').filter(entry =>
      String(entry.charge_data?.account_payment_id ?? '') === accountId
    );
    const [card] = cards;
    const methods = array(paymentPayload?.payment_methods, 'payment_methods').filter(method => method.id === 'cc');
    if (!accountId || cards.length !== 1 || card.available !== true || card.blocked
      || methods.length !== 1 || methods[0].available !== true) {
      throw new ApiError('Selected saved card cannot be verified against current payment methods.');
    }
    const alias = cleanRemote(card.alias);
    const brand = cleanRemote(card.card_brand ?? card.card_type);
    return {
      payment_method_id: `cc|${accountId}`,
      payment_method_label: `${alias ? `${alias} — ` : ''}${brand} •••• ${cleanRemote(card.last_four_digits)}`,
    };
  }
  const method = array(paymentPayload?.payment_methods, 'payment_methods').find(entry => String(entry.id) === type);
  if (!method || method.available !== true) throw new ApiError('Selected payment method is not currently available.');
  return {
    payment_method_id: type,
    payment_method_label: cleanRemote(method.main_description ?? method.description ?? type),
  };
}

function storesForType(payload, storeType) {
  const groups = extractCartGroups(payload);
  if (groups.some(group => !cartType(group))) {
    throw new ApiError('Cart groups must declare their cart type before mutation.');
  }
  const direct = groups.every(group => !Array.isArray(group.stores));
  const nested = groups.every(group => Array.isArray(group.stores));
  if (!direct && !nested) throw new ApiError('Cart response mixes incompatible group shapes.');
  const matches = groups.filter(group => cartType(group) === storeType);
  if (groups.length && !matches.length) throw new ApiError('No cart group declares the requested cart type; refusing to infer a retailer mapping.');
  if (direct) {
    const ids = new Set(matches.map(store => String(store.id ?? store.store_id)));
    if (ids.size !== matches.length) throw new ApiError('Cart response contains ambiguous stores for the cart type.');
    return clone(matches);
  }
  if (matches.length > 1) throw new ApiError('Cart response contains ambiguous groups for the cart type.');
  return matches.length ? clone(matches[0].stores) : [];
}

function sameId(left, right) {
  return String(left) === String(right);
}

export function buildCartMutation(payload, { storeType, storeId, product, units }) {
  const desiredUnits = finiteNumber(units);
  if (!Number.isSafeInteger(desiredUnits) || desiredUnits < 0 || desiredUnits > 100) throw new ApiError('units must be an integer from 0 to 100.');
  object(product, 'product');
  if (!validId(storeId) || !validId(product.id ?? product.product_id)) throw new ApiError('Cart mutation requires valid store and product IDs.');
  const stores = storesForType(payload, storeType);
  let store = stores.find(entry => sameId(entry.id ?? entry.store_id, storeId));
  if (!store) {
    if (desiredUnits === 0) throw new ApiError('Cannot remove a product from a store that is not in the cart.');
    store = { id: Number.isSafeInteger(Number(storeId)) ? Number(storeId) : String(storeId), products: [] };
    stores.push(store);
  }
  if (!Array.isArray(store.products)) throw new ApiError('Existing store cart products have an invalid shape.');
  const productId = String(product.id ?? product.product_id ?? '');
  const index = store.products.findIndex(entry => sameId(entry.id ?? entry.product_id, productId));
  if (desiredUnits === 0) {
    if (index < 0) throw new ApiError('Product is not present in the selected store cart.');
    store.products.splice(index, 1);
  } else if (index >= 0) {
    store.products[index] = { ...store.products[index], units: desiredUnits };
  } else {
    store.products.push({
      id: productId,
      units: desiredUnits,
      sale_type: cleanRemote(product.sale_type || 'U'),
      comment: '',
      toppings: [],
    });
  }
  return stores;
}

export function verifyCartMutation(payload, { storeType, storeId, productId, units }) {
  const summary = summarizeCarts(payload);
  if (storeType !== undefined && summary.stores.some(store => !store.store_type)) {
    throw new ApiError('Cart readback does not declare its cart type.');
  }
  const matches = summary.stores.filter(entry => sameId(entry.store_id, storeId)
    && (storeType === undefined || entry.store_type === storeType));
  if (matches.length > 1) throw new ApiError('Cart readback contains ambiguous stores.');
  const [store] = matches;
  const product = store?.products.find(entry => sameId(entry.product_id, productId));
  if (units === 0) {
    if (product) throw new ApiError('Cart readback still contains the removed product.');
  } else if (!product || product.units !== units) {
    throw new ApiError('Cart readback does not match the requested product quantity.');
  }
  return summary;
}

function summarizeUnknownOrder(row) {
  object(row, 'order');
  const id = row.id ?? row.order_id ?? row.orderId;
  if (!validId(id)) throw new ApiError('Order response contains an unrecognized order shape.');
  const total = row.total ?? row.total_price ?? row.amount ?? row.price;
  return {
    order_id: id == null ? null : String(id),
    status: cleanRemote(row.status ?? row.state ?? row.order_status ?? ''),
    store_id: validId(row.store_id) ? String(row.store_id) : null,
    store_name: cleanRemote(row.store_name ?? row.store?.name ?? row.name ?? ''),
    store_type: cleanRemote(typeof row.store_type === 'string' ? row.store_type
      : (typeof row.store_type_store === 'string' ? row.store_type_store : '')),
    store_type_group: cleanRemote(typeof row.store_type_group === 'string' ? row.store_type_group : ''),
    total: finiteNumber(total),
    created_at: cleanRemote(row.created_at ?? row.createdAt ?? row.date ?? ''),
    updated_at: cleanRemote(row.updated_at ?? row.updatedAt ?? ''),
  };
}

export function summarizeOrders(payload) {
  let rows;
  if (Array.isArray(payload)) rows = payload;
  else if (Array.isArray(payload?.orders)) rows = payload.orders;
  else if (Array.isArray(payload?.cards)) rows = payload.cards;
  else if (Array.isArray(payload?.data)) rows = payload.data;
  else throw new ApiError('Order response has an invalid shape.');
  return { order_count: rows.length, orders: rows.map(summarizeUnknownOrder) };
}

function recursiveNumber(root, aliases) {
  const wanted = new Set(aliases.map(alias => alias.toLowerCase()));
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase())) {
        const number = finiteNumber(child);
        if (number === null) throw new ApiError(`Checkout ${key} is not a valid monetary amount.`);
        return number;
      }
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return null;
}

function recursiveString(root, aliases) {
  const wanted = new Set(aliases.map(alias => alias.toLowerCase()));
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase()) && (typeof child === 'string' || typeof child === 'number')) return cleanRemote(child);
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return '';
}

function findStoreAmounts(root, storeId) {
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const candidateId = value.store_id ?? value.storeId;
    if (candidateId != null && String(candidateId) === String(storeId)) {
      const total = recursiveNumber(value, ['final_total', 'total_to_pay', 'total', 'total_price']);
      if (Number.isFinite(total)) {
        return {
          item_subtotal_centavos: moneyToCents(recursiveNumber(value, ['item_subtotal', 'products_total', 'subtotal']) ?? 0, 'store item subtotal'),
          discount_total_centavos: moneyToCents(recursiveNumber(value, ['discount_total', 'discounts_total', 'total_discount']) ?? 0, 'store discount'),
          delivery_total_centavos: moneyToCents(recursiveNumber(value, ['delivery_total', 'delivery_price', 'shipping_cost']) ?? 0, 'store delivery'),
          service_fee_total_centavos: moneyToCents(recursiveNumber(value, ['service_fee_total', 'service_fee']) ?? 0, 'store service fee'),
          mandatory_charges_total_centavos: moneyToCents(recursiveNumber(value, ['mandatory_charges_total', 'charges_total']) ?? 0, 'store mandatory charges'),
          tip_centavos: moneyToCents(recursiveNumber(value, ['tip', 'tip_total']) ?? 0, 'store tip'),
          final_total_centavos: moneyToCents(total, 'store final total'),
        };
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push(child);
  }
  return null;
}

function directNumber(root, aliases) {
  const containers = [
    root,
    root?.data,
    root?.summary,
    root?.checkout,
    root?.data?.summary,
    root?.data?.checkout,
  ].filter(value => value && typeof value === 'object' && !Array.isArray(value));
  for (const alias of aliases) {
    for (const container of containers) {
      if (!Object.hasOwn(container, alias)) continue;
      const number = finiteNumber(container[alias]);
      if (number === null) throw new ApiError(`Checkout ${alias} is not a valid monetary amount.`);
      return number;
    }
  }
  return null;
}

function typedSummaryNumber(root, aliases) {
  const wanted = new Set(aliases.map(alias => alias.toLowerCase()));
  const queue = [root];
  const seen = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const discriminators = [value.type, value.name].filter(entry => entry != null).map(entry => String(entry).toLowerCase());
    if (discriminators.some(entry => wanted.has(entry))) {
      const field = ['raw_value', 'rawValue', 'amount'].find(key => Object.hasOwn(value, key));
      const amount = finiteNumber(value[field]);
      if (amount === null) throw new ApiError('Checkout summary contains an invalid monetary amount.');
      return amount;
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push(child);
  }
  return null;
}

export function buildCheckoutSnapshot({ storeType, cartSummary, recalculation, detail, summary, components, address, payment }) {
  const total = directNumber(recalculation, ['final_total', 'total_to_pay', 'grand_total', 'total_price', 'total']);
  if (!Number.isFinite(total) || total < 0) throw new ApiError('Checkout recalculation does not expose a valid final total.');
  const productSubtotal = typedSummaryNumber(summary, ['product_total', 'products_total', 'subtotal'])
    ?? directNumber(summary, ['item_subtotal', 'product_total', 'products_total', 'subtotal'])
    ?? directNumber(recalculation, ['product_total', 'sub_total'])
    ?? (cartSummary?.stores ?? []).reduce((sum, store) =>
      sum + (store.products ?? []).reduce((inner, product) => {
        const price = finiteNumber(product.unit_price);
        const units = finiteNumber(product.units);
        if (price === null || units === null) throw new ApiError('Checkout item subtotal cannot be verified from cart prices.');
        return inner + price * units;
      }, 0), 0);
  const discount = typedSummaryNumber(summary, ['discount', 'discount_total'])
    ?? directNumber(summary, ['discount_total', 'discounts_total', 'total_discount']) ?? 0;
  const delivery = typedSummaryNumber(summary, ['shipping', 'delivery'])
    ?? directNumber(summary, ['delivery_total', 'delivery_price', 'shipping_cost', 'shipping_total'])
    ?? directNumber(recalculation, ['shipping_total'])
    ?? 0;
  const serviceFee = typedSummaryNumber(summary, ['service_fee'])
    ?? directNumber(summary, ['service_fee_total', 'service_fee']) ?? 0;
  const tip = typedSummaryNumber(summary, ['tip'])
    ?? directNumber(summary, ['tip', 'tip_total']) ?? directNumber(recalculation, ['tip']) ?? 0;
  const explicitMandatory = typedSummaryNumber(summary, ['mandatory_charges', 'mandatory_charges_total'])
    ?? directNumber(summary, ['mandatory_charges_total', 'charges_total']);
  const mandatory = explicitMandatory ?? Math.max(0, total - productSubtotal + discount - delivery - serviceFee - tip);
  const paymentId = cleanRemote(payment?.payment_method_id) || recursiveString(detail, ['payment_method_id', 'paymentmethodid', 'payment_id']);
  const paymentLabel = cleanRemote(payment?.payment_method_label) || recursiveString(detail, ['payment_method_label', 'payment_method_name', 'payment_name']);
  if (!address?.id) throw new ApiError('Checkout address is missing.');
  const stores = array(cartSummary.stores, 'cart stores').map(store => ({
    id: String(store.store_id),
    products: store.products.map(product => ({ id: String(product.product_id), units: Number(product.units) })),
  }));
  if (!stores.length || stores.some(store => !store.products.length)) throw new ApiError('Checkout cart has no products.');
  if (stores.length === 1) {
    Object.assign(stores[0], {
      item_subtotal_centavos: moneyToCents(productSubtotal, 'store item subtotal'),
      discount_total_centavos: moneyToCents(discount, 'store discount'),
      delivery_total_centavos: moneyToCents(delivery, 'store delivery'),
      service_fee_total_centavos: moneyToCents(serviceFee, 'store service fee'),
      mandatory_charges_total_centavos: moneyToCents(mandatory, 'store mandatory charges'),
      tip_centavos: moneyToCents(tip, 'store tip'),
      final_total_centavos: moneyToCents(total, 'store final total'),
    });
  } else {
    for (const store of stores) {
      const amounts = findStoreAmounts(recalculation, store.id) ?? findStoreAmounts(summary, store.id);
      if (!amounts) throw new ApiError(`Checkout does not expose verifiable totals for store ${store.id}.`);
      Object.assign(store, amounts);
    }
  }
  if (stores.length > 1) {
    const aggregate = {
      item_subtotal_centavos: moneyToCents(productSubtotal, 'item subtotal'),
      discount_total_centavos: moneyToCents(discount, 'discount total'),
      delivery_total_centavos: moneyToCents(delivery, 'delivery total'),
      service_fee_total_centavos: moneyToCents(serviceFee, 'service fee'),
      mandatory_charges_total_centavos: moneyToCents(mandatory, 'mandatory charges'),
      tip_centavos: moneyToCents(tip, 'tip'),
      final_total_centavos: moneyToCents(total, 'final total'),
    };
    for (const [field, expected] of Object.entries(aggregate)) {
      const sum = stores.reduce((value, store) => value + store[field], 0);
      if (sum !== expected) throw new ApiError(`Per-store ${field} does not equal the approved aggregate.`);
    }
  }
  return {
    store_type: storeType,
    stores,
    item_subtotal_centavos: moneyToCents(productSubtotal, 'item subtotal'),
    discount_total_centavos: moneyToCents(discount, 'discount total'),
    delivery_total_centavos: moneyToCents(delivery, 'delivery total'),
    service_fee_total_centavos: moneyToCents(serviceFee, 'service fee'),
    mandatory_charges_total_centavos: moneyToCents(mandatory, 'mandatory charges'),
    tip_centavos: moneyToCents(tip, 'tip'),
    final_total_centavos: moneyToCents(total, 'final total'),
    address_id: String(address.id),
    address_label: cleanRemote(address.label ?? 'Endereço ativo'),
    delivery_window: recursiveString(components, ['delivery_window', 'delivery_time', 'scheduled_at']) || 'now',
    payment_method_id: paymentId || 'unresolved',
    payment_method_label: paymentLabel || (paymentId ? 'Método salvo' : 'Não selecionado'),
  };
}
