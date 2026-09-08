import { setTimeout as delay } from 'node:timers/promises';
import { loadSession, deleteSession, sessionStatus } from './session.mjs';
import { RappiClient, ApiError, SessionExpiredError } from './api.mjs';
import {
  parseSearchOptions, rankSearch, summarizeCarts, buildCartMutation, selectCartCandidate,
  verifyCartMutation, summarizeOrders, buildCheckoutSnapshot, parsePositiveInteger,
  summarizePaymentMethods, buildPaymentSelection, resolveSelectedPayment, selectCheckoutStores,
} from './operations.mjs';
import { checkoutContextHashes, prepareApproval, claimApproval, cancelApproval } from './approval.mjs';

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parseFlags(args) {
  const flags = new Map();
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const [name, inline] = token.slice(2).split('=', 2);
    if (!/^[a-z][a-z0-9-]*$/.test(name) || flags.has(name)) throw new ApiError(`Invalid or repeated option: --${name}.`);
    const value = inline ?? args[++index];
    if (value == null || value.startsWith('--')) throw new ApiError(`Option --${name} requires a value.`);
    flags.set(name, value);
  }
  return { flags, positionals };
}

function requireFlag(flags, name) {
  const value = flags.get(name);
  if (!value) throw new ApiError(`Missing required option --${name}.`);
  return value;
}

function rejectUnknown(flags, allowed) {
  for (const name of flags.keys()) if (!allowed.includes(name)) throw new ApiError(`Unknown option: --${name}.`);
}

async function clientForSession() {
  const session = await loadSession();
  return { client: new RappiClient(session.headers), session };
}

async function enrichRestaurantDescriptions(client, results) {
  const stores = new Map();
  for (const result of results) {
    if (result.cart_type !== 'restaurant') continue;
    const rows = stores.get(result.store_id) ?? [];
    rows.push(result);
    stores.set(result.store_id, rows);
  }
  const entries = [...stores.entries()];
  for (let offset = 0; offset < entries.length; offset += 5) {
    const batch = await Promise.all(entries.slice(offset, offset + 5).map(async ([storeId, rows]) => {
      try {
        return [rows, await client.restaurantMenuDescriptions(storeId)];
      } catch (error) {
        if (error instanceof SessionExpiredError) throw error;
        return [rows, null];
      }
    }));
    for (const [rows, descriptions] of batch) {
      if (!descriptions) continue;
      for (const row of rows) row.description = descriptions.get(row.product_id) ?? null;
    }
  }
}

async function searchCommand(args) {
  const options = parseSearchOptions(args);
  const { client } = await clientForSession();
  const { results, ...summary } = rankSearch(await client.search(options.query), options);
  await enrichRestaurantDescriptions(client, results);
  const header = JSON.stringify(summary).slice(0, -1);
  process.stdout.write(`${header},"results":[\n${results.map(row => JSON.stringify(row)).join(',\n')}\n]}\n`);
}

async function authCommand(args) {
  const action = args[0] ?? 'status';
  if (args.length > 1) throw new ApiError('auth status/clear accept no extra arguments.');
  if (action === 'clear') {
    await deleteSession();
    output({ authenticated: false, session_deleted: true });
    return;
  }
  if (action !== 'status') return false;
  const status = await sessionStatus();
  if (!status.saved) {
    output({ authenticated: false, saved: false });
    return true;
  }
  const { client, session } = await clientForSession();
  await client.auth();
  output({ authenticated: true, saved: true, saved_at: new Date(session.saved_at).toISOString() });
  return true;
}

async function addressCommand(args) {
  const action = args[0] ?? 'list';
  const { client } = await clientForSession();
  if (action === 'list' && args.length === 1) {
    const addresses = await client.addresses();
    output({ addresses });
    return;
  }
  if (action === 'set' && args.length === 2) {
    const addresses = await client.setActiveAddress(args[1]);
    output({ changed: true, addresses });
    return;
  }
  throw new ApiError('Usage: addresses list | addresses set <address-id>.');
}

async function ordersCommand(args) {
  if (args.length && !(args.length === 1 && args[0] === 'list')) throw new ApiError('Usage: orders list.');
  const { client } = await clientForSession();
  output(summarizeOrders(await client.ordersRaw()));
}

async function cartCommand(args) {
  const action = args[0] ?? 'get';
  const { client } = await clientForSession();
  if (action === 'get' && args.length === 1) {
    output(summarizeCarts(await client.cartsRaw()));
    return;
  }
  if (!['add', 'remove'].includes(action)) throw new ApiError('Usage: cart get | cart add ... | cart remove ...');
  const { flags, positionals } = parseFlags(args.slice(1));
  if (positionals.length) throw new ApiError('Cart mutations accept options only.');
  rejectUnknown(flags, ['store-type', 'store-id', 'product-id', 'query', 'units']);
  const storeType = requireFlag(flags, 'store-type');
  const storeId = requireFlag(flags, 'store-id');
  const productId = requireFlag(flags, 'product-id');
  const units = action === 'remove' ? 0 : parsePositiveInteger(flags.get('units') ?? 1, 'units', 100);
  let product = { id: productId, sale_type: 'U' };
  if (action === 'add') {
    const query = requireFlag(flags, 'query');
    const found = selectCartCandidate((await client.search(query)).results, { storeType, storeId, productId });
    if (found.age_restriction || found.requires_prescription) throw new ApiError('Regulated product requires a separate explicit item-level flow and cannot be added by this command.');
    if (units < found.minimum_units) throw new ApiError(`Product requires at least ${found.minimum_units} units.`);
    product = { id: found.product_id, sale_type: found.sale_type || 'U' };
  }
  const before = await client.cartsRaw();
  const payload = buildCartMutation(before, { storeType, storeId, product, units });
  await client.replaceStoreCart(storeType, payload);
  const after = await client.cartsRaw();
  output({ changed: true, cart: verifyCartMutation(after, { storeType, storeId, productId, units }) });
}



async function paymentCommand(args) {
  const action = args[0] ?? 'list';
  if (!['list', 'select'].includes(action)) throw new ApiError('Usage: payments list|select --store-type TYPE --store-id ID [--alias NAME].');
  const { flags, positionals } = parseFlags(args.slice(1));
  rejectUnknown(flags, ['store-type', 'store-id', 'alias']);
  if (positionals.length) throw new ApiError('Payment commands accept options only.');
  const storeType = requireFlag(flags, 'store-type');
  const storeId = requireFlag(flags, 'store-id');
  const { client } = await clientForSession();
  const address = await client.activeLocation();
  const methods = await client.paymentMethods(storeType, storeId, { zoneId: address.zone_id, zoneName: address.zone_name });
  if (action === 'list') {
    if (flags.has('alias')) throw new ApiError('payments list does not accept --alias.');
    output(summarizePaymentMethods(methods));
    return;
  }
  const currentCart = await client.cartsRaw();
  const stores = selectCheckoutStores(summarizeCarts(currentCart), storeType);
  if (!stores.some(store => store.store_id === storeId)) throw new ApiError('Selected payment store is not present in that cart.');
  const { payload, selection } = buildPaymentSelection(methods, requireFlag(flags, 'alias'), { cartPayload: currentCart, storeType });
  await client.selectPaymentMethod(storeType, payload);
  const cart = await client.cartsRaw();
  const selected = resolveSelectedPayment(cart, storeType, methods);
  const verifiedPayment = buildPaymentSelection(methods, requireFlag(flags, 'alias'), { cartPayload: cart, storeType }).payload;
  if (verifiedPayment.rappi_credit.use_rappi_credit !== payload.rappi_credit.use_rappi_credit
      || verifiedPayment.rappi_pay.use_rappi_pay !== payload.rappi_pay.use_rappi_pay
      || verifiedPayment.rappi_pay.rappi_pay_method_active !== payload.rappi_pay.rappi_pay_method_active) {
    throw new ApiError('Payment update changed credit settings; inspect the cart before proceeding. Do not repeat automatically.');
  }
  if (selected.payment_method_id !== selection.payment_method_id) {
    throw new ApiError('Payment update was sent, but the selected card could not be verified. Do not repeat automatically.');
  }
  output({ changed: true, payment: { label: selection.payment_method_label } });
}

async function checkoutData(client, storeType) {
  const cartRaw = await client.cartsRaw();
  const cart = summarizeCarts(cartRaw);
  const stores = selectCheckoutStores(cart, storeType);
  if (!stores.length) throw new ApiError(`No ${storeType} cart is available.`);
  const storeIds = stores.map(store => store.store_id);
  const address = await client.activeLocation();
  const [recalculation, detail, summary, components, tip, paymentMethods] = await Promise.all([
    client.recalculate(storeType),
    client.checkoutDetail(storeType),
    client.checkoutSummary(storeType),
    client.checkoutComponents(storeType, storeIds),
    client.tipSegmentation(storeType, storeIds[0]),
    client.paymentMethods(storeType, storeIds[0], { zoneId: address.zone_id, zoneName: address.zone_name }),
  ]);
  const payment = resolveSelectedPayment(cartRaw, storeType, paymentMethods);
  const snapshot = buildCheckoutSnapshot({
    storeType,
    cartSummary: { stores },
    recalculation,
    detail,
    summary,
    components,
    address,
    payment,
  });
  Object.assign(snapshot, checkoutContextHashes(recalculation, paymentMethods, payment.payment_method_id, snapshot.tip_centavos));
  return { snapshot, recalculation };
}

function checkoutReview(snapshot) {
  return {
    store_type: snapshot.store_type,
    stores: snapshot.stores,
    item_subtotal: snapshot.item_subtotal_centavos / 100,
    discounts: snapshot.discount_total_centavos / 100,
    delivery: snapshot.delivery_total_centavos / 100,
    service_fee: snapshot.service_fee_total_centavos / 100,
    mandatory_charges: snapshot.mandatory_charges_total_centavos / 100,
    tip: snapshot.tip_centavos / 100,
    final_total: snapshot.final_total_centavos / 100,
    address_label: snapshot.address_label,
    delivery_window: snapshot.delivery_window,
    payment_method_label: snapshot.payment_method_label,
  };
}

async function checkoutCommand(args) {
  const action = args[0];
  if (!['preview', 'approve', 'cancel'].includes(action)) {
    throw new ApiError('Usage: checkout preview|approve --store-type <type> | checkout cancel <approval-id>.');
  }
  if (action === 'cancel') {
    if (args.length !== 2) throw new ApiError('Usage: checkout cancel <approval-id>.');
    await cancelApproval(args[1]);
    output({ cancelled: true, approval_id: args[1] });
    return;
  }
  const { flags, positionals } = parseFlags(args.slice(1));
  rejectUnknown(flags, ['store-type']);
  if (positionals.length) throw new ApiError(`checkout ${action} accepts options only.`);
  const { client } = await clientForSession();
  const { snapshot } = await checkoutData(client, requireFlag(flags, 'store-type'));
  if (action === 'preview') {
    output({ checkout: checkoutReview(snapshot) });
    return;
  }
  if (snapshot.payment_method_id === 'unresolved') throw new ApiError('Checkout payment method could not be resolved safely.');
  const approval = await prepareApproval(snapshot);
  output({ approval, review: checkoutReview(snapshot) });
}

export function collectOrderIds(value, found = new Set(), depth = 0, context = '') {
  if (depth > 8 || value == null) return found;
  const add = id => {
    if ((typeof id === 'string' || typeof id === 'number') && /^[A-Za-z0-9_-]{1,100}$/.test(String(id))) found.add(String(id));
  };
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (context === 'order_ids') add(entry);
      else collectOrderIds(entry, found, depth + 1, context);
    }
    return found;
  }
  if (typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:order_?id|id_?order)$/i.test(key) || (key === 'id' && ['order', 'orders'].includes(context))) add(child);
    else if (['data', 'result', 'order', 'orders', 'order_ids'].includes(key)) {
      collectOrderIds(child, found, depth + 1, key);
    }
  }
  return found;
}

export async function reconcileOrders(client, orderIds, snapshot, {
  attempts = 8, intervalMs = 3000, beforeOrderIds = [], allowDiscovery = false,
} = {}) {
  const baseline = new Set(beforeOrderIds);
  let observed = [];
  let readFailures = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const orders = summarizeOrders(await client.ordersRaw({ timeout: 3000 })).orders;
      const visible = orders.filter(order => orderIds.length
        ? orderIds.includes(order.order_id)
        : allowDiscovery && order.order_id && !baseline.has(order.order_id));
      for (const order of visible) {
        const index = observed.findIndex(row => row.order_id === order.order_id);
        if (index < 0) observed.push(order);
        else observed[index] = order;
      }
      if (orderIds.length && new Set(visible.map(order => order.order_id)).size === orderIds.length
          && visible.length === orderIds.length && orderIds.length === snapshot.stores.length) {
        const unmatched = [...visible];
        const allStoresMatch = snapshot.stores.every(store => {
          const index = unmatched.findIndex(order =>
            order.store_id === String(store.id)
            && order.total != null && Number.isFinite(order.total)
            && Math.round(order.total * 100) === store.final_total_centavos
          );
          if (index < 0) return false;
          unmatched.splice(index, 1);
          return true;
        });
        if (allStoresMatch) return { confirmed: true, placement_observed: true, orders: visible };
      }
    } catch {
      // A failed status read never changes the outcome of the already-dispatched purchase.
      readFailures += 1;
    }
    if (attempt < attempts - 1) await delay(intervalMs);
  }
  const placementObserved = orderIds.length > 0
    && orderIds.every(id => observed.some(order => order.order_id === id));
  return {
    confirmed: false,
    placement_observed: placementObserved,
    orders: orderIds.length ? observed : [],
    candidate_orders: orderIds.length ? [] : observed,
    unresolved_order_ids: orderIds.filter(id => !observed.some(order => order.order_id === id)),
    read_failures: readFailures,
    reason: placementObserved
      ? 'Rappi lists the returned order IDs, but store and amount verification is incomplete. Do not reorder.'
      : observed.length
        ? 'New orders appeared after submission, but their link to this checkout is unproven. Do not reorder.'
        : 'No conclusive order status is available yet. Absence from this list does not prove failure. Do not reorder.',
  };
}

async function orderCommand(args) {
  const { flags, positionals } = parseFlags(args);
  rejectUnknown(flags, ['store-type', 'approval-id']);
  if (positionals.length) throw new ApiError('order accepts options only.');
  const storeType = requireFlag(flags, 'store-type');
  const approvalId = requireFlag(flags, 'approval-id');
  const { client } = await clientForSession();
  const { snapshot, recalculation } = await checkoutData(client, storeType);
  const beforeOrderIds = summarizeOrders(await client.ordersRaw()).orders.map(order => order.order_id).filter(Boolean);
  await claimApproval(approvalId, snapshot);
  let response;
  let submissionError = false;
  try {
    response = await client.checkout(storeType, recalculation);
  } catch {
    submissionError = true;
  }
  // Once checkout has been invoked, never report an ordinary retryable failure.
  const orderIds = [...collectOrderIds(response)];
  const reconciliation = await reconcileOrders(client, orderIds, snapshot, {
    beforeOrderIds, allowDiscovery: true,
  });
  output({
    status: reconciliation.confirmed ? 'confirmed' : reconciliation.placement_observed ? 'created_unverified' : 'ambiguous',
    order_ids: orderIds,
    reconciliation,
    submission_response_error: submissionError,
    retried: false,
    message: reconciliation.confirmed ? 'Every order was verified.'
      : 'Checkout was submitted once. Do not place another order; inspect the listed orders or the official Rappi app.',
  });
  if (!reconciliation.confirmed) process.exitCode = 2;
}

export async function runApiCommand(command, args) {
  try {
    if (command === 'search') return await searchCommand(args);
    if (command === 'auth') {
      const handled = await authCommand(args);
      if (handled !== false) return;
    }
    if (command === 'payments') return await paymentCommand(args);
    if (command === 'addresses') return await addressCommand(args);
    if (command === 'orders') return await ordersCommand(args);
    if (command === 'cart') return await cartCommand(args);
    if (command === 'checkout') return await checkoutCommand(args);
    if (command === 'order') return await orderCommand(args);
    return false;
  } catch (error) {
    if (error instanceof SessionExpiredError || error instanceof ApiError) throw error;
    throw new ApiError(error.message);
  }
}
