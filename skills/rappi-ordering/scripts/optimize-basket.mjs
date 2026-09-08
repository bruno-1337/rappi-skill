#!/usr/bin/env bun

const MAX_STORES = 24;
const MAX_COMBINATIONS = 50_000;
const MAX_STATES = 100_000;
const MAX_RESULTS = 10;

function fail(message) {
  throw new Error(message);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a finite number`);
  return number;
}

function positiveInteger(value, label) {
  const number = finiteNumber(value, label);
  if (!Number.isInteger(number) || number <= 0) fail(`${label} must be a positive integer`);
  return number;
}

function cents(value, label) {
  const number = finiteNumber(value ?? 0, label);
  if (number < 0) fail(`${label} cannot be negative`);
  return Math.round((number + Number.EPSILON) * 100);
}

function money(value) {
  return Number((value / 100).toFixed(2));
}

function combinations(values, maxSize) {
  const output = [];
  function visit(start, selected) {
    if (selected.length) {
      output.push([...selected]);
      if (output.length > MAX_COMBINATIONS) fail(`too many store combinations; narrow candidates below ${MAX_STORES} stores`);
    }
    if (selected.length === maxSize) return;
    for (let index = start; index < values.length; index += 1) {
      selected.push(values[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  }
  visit(0, []);
  return output;
}

function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("input must be an object");
  if (!Array.isArray(input.items) || input.items.length === 0) fail("items must be a non-empty array");

  const maxStores = positiveInteger(input.max_stores ?? 2, "max_stores");
  if (maxStores > 4) fail("max_stores cannot exceed 4");

  const itemIds = new Set();
  const stores = new Map();
  const items = input.items.map((item, itemIndex) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`items[${itemIndex}] must be an object`);
    const id = String(item.id ?? "").trim();
    if (!id) fail(`items[${itemIndex}].id is required`);
    if (itemIds.has(id)) fail(`duplicate item id: ${id}`);
    itemIds.add(id);
    const label = String(item.label ?? id);
    const quantity = positiveInteger(item.quantity ?? 1, `items[${itemIndex}].quantity`);
    if (!Array.isArray(item.candidates) || item.candidates.length === 0) fail(`items[${itemIndex}].candidates must be non-empty`);

    const candidates = item.candidates.flatMap((candidate, candidateIndex) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) fail(`candidate ${id}[${candidateIndex}] must be an object`);
      if (candidate.available === false) return [];
      const storeId = String(candidate.store_id ?? "").trim();
      const productId = String(candidate.product_id ?? "").trim();
      if (!storeId || !productId) fail(`candidate ${id}[${candidateIndex}] requires store_id and product_id`);
      const storeName = String(candidate.store_name ?? storeId);
      const unitCents = cents(candidate.unit_price, `candidate ${id}[${candidateIndex}].unit_price`);
      if (unitCents === 0) fail(`candidate ${id}[${candidateIndex}].unit_price must be positive`);
      const shippingCents = cents(candidate.shipping_cost ?? 0, `candidate ${id}[${candidateIndex}].shipping_cost`);
      const serviceCents = cents(candidate.service_fee ?? 0, `candidate ${id}[${candidateIndex}].service_fee`);
      const mandatoryCents = cents(candidate.mandatory_charges ?? 0, `candidate ${id}[${candidateIndex}].mandatory_charges`);
      const tipCents = cents(candidate.tip ?? 0, `candidate ${id}[${candidateIndex}].tip`);
      const discountCents = cents(candidate.basket_discount ?? 0, `candidate ${id}[${candidateIndex}].basket_discount`);
      const minimumCents = cents(candidate.minimum_order ?? 0, `candidate ${id}[${candidateIndex}].minimum_order`);
      const etaMinutes = candidate.eta_minutes == null ? null : finiteNumber(candidate.eta_minutes, `candidate ${id}[${candidateIndex}].eta_minutes`);
      if (etaMinutes != null && etaMinutes < 0) fail(`candidate ${id}[${candidateIndex}].eta_minutes cannot be negative`);

      const prior = stores.get(storeId);
      const metadata = {
        id: storeId,
        name: storeName,
        shippingCents,
        serviceCents,
        mandatoryCents,
        tipCents,
        discountCents,
        minimumCents,
        etaMinutes,
      };
      if (prior) {
        prior.shippingCents = Math.max(prior.shippingCents, shippingCents);
        prior.serviceCents = Math.max(prior.serviceCents, serviceCents);
        prior.mandatoryCents = Math.max(prior.mandatoryCents, mandatoryCents);
        prior.tipCents = Math.max(prior.tipCents, tipCents);
        prior.discountCents = Math.min(prior.discountCents, discountCents);
        prior.minimumCents = Math.max(prior.minimumCents, minimumCents);
        if (prior.etaMinutes == null || (etaMinutes != null && etaMinutes > prior.etaMinutes)) prior.etaMinutes = etaMinutes;
      } else {
        stores.set(storeId, metadata);
      }

      return [{
        itemId: id,
        itemLabel: label,
        storeId,
        storeName,
        productId,
        productName: String(candidate.product_name ?? productId),
        quantity,
        unitCents,
        lineCents: unitCents * quantity,
      }];
    });

    if (candidates.length === 0) fail(`item ${id} has no available candidates`);
    return { id, label, quantity, candidates };
  });

  if (stores.size > MAX_STORES) fail(`candidate set has ${stores.size} stores; maximum is ${MAX_STORES}`);
  return { items, stores, maxStores: Math.min(maxStores, stores.size) };
}

function storeTotal(store) {
  return Math.max(0, store.subtotalCents - store.discountCents)
    + store.shippingCents
    + store.serviceCents
    + store.mandatoryCents
    + store.tipCents;
}

function evaluate(normalized, selectedStoreIds) {
  const storeIndex = new Map(selectedStoreIds.map((id, index) => [id, index]));
  const stores = selectedStoreIds.map((id) => normalized.stores.get(id));
  let states = new Map([[`0|${stores.map(() => 0).join(",")}`, {
    itemCostCents: 0,
    usedMask: 0,
    cappedSubtotals: stores.map(() => 0),
    assignments: [],
  }]]);

  for (const item of normalized.items) {
    const bestByStore = new Map();
    for (const candidate of item.candidates) {
      const index = storeIndex.get(candidate.storeId);
      if (index == null) continue;
      const prior = bestByStore.get(index);
      if (!prior || candidate.lineCents < prior.lineCents || (
        candidate.lineCents === prior.lineCents
        && candidate.productId.localeCompare(prior.productId) < 0
      )) bestByStore.set(index, candidate);
    }
    if (bestByStore.size === 0) return null;

    const next = new Map();
    for (const state of states.values()) {
      for (const [index, candidate] of bestByStore) {
        const cappedSubtotals = [...state.cappedSubtotals];
        cappedSubtotals[index] = Math.min(
          stores[index].minimumCents,
          cappedSubtotals[index] + candidate.lineCents,
        );
        const usedMask = state.usedMask | (1 << index);
        const itemCostCents = state.itemCostCents + candidate.lineCents;
        const key = `${usedMask}|${cappedSubtotals.join(",")}`;
        const prior = next.get(key);
        if (!prior || itemCostCents < prior.itemCostCents) {
          next.set(key, {
            itemCostCents,
            usedMask,
            cappedSubtotals,
            assignments: [...state.assignments, candidate],
          });
        }
      }
    }
    if (next.size > MAX_STATES) fail("basket assignment is too complex; narrow equivalent candidates");
    states = next;
  }

  let best = null;
  for (const state of states.values()) {
    const groups = new Map();
    for (const assignment of state.assignments) {
      let group = groups.get(assignment.storeId);
      if (!group) {
        group = { ...normalized.stores.get(assignment.storeId), subtotalCents: 0, items: [] };
        groups.set(assignment.storeId, group);
      }
      group.subtotalCents += assignment.lineCents;
      group.items.push(assignment);
    }
    if ([...groups.values()].some((group) => group.subtotalCents < group.minimumCents)) continue;

    const usedStores = [...groups.values()].sort((left, right) => left.id.localeCompare(right.id));
    const totalCents = usedStores.reduce((sum, store) => sum + storeTotal(store), 0);
    const etaMinutes = Math.max(...usedStores.map((store) => store.etaMinutes ?? 0));
    const signature = state.assignments
      .slice()
      .sort((left, right) => left.itemId.localeCompare(right.itemId))
      .map((entry) => `${entry.itemId}:${entry.storeId}:${entry.productId}`)
      .join("|");
    const option = { totalCents, etaMinutes, signature, stores: usedStores };
    if (!best || totalCents < best.totalCents || (
      totalCents === best.totalCents
      && (usedStores.length < best.stores.length || (
        usedStores.length === best.stores.length && etaMinutes < best.etaMinutes
      ))
    )) best = option;
  }
  return best;
}

function present(option) {
  if (!option) return null;
  return {
    total: money(option.totalCents),
    store_count: option.stores.length,
    eta_minutes: option.etaMinutes || null,
    stores: option.stores.map((store) => ({
      store_id: store.id,
      store_name: store.name,
      item_subtotal: money(store.subtotalCents),
      basket_discount: money(store.discountCents),
      shipping_cost: money(store.shippingCents),
      service_fee: money(store.serviceCents),
      mandatory_charges: money(store.mandatoryCents),
      tip: money(store.tipCents),
      minimum_order: money(store.minimumCents),
      eta_minutes: store.etaMinutes,
      total: money(storeTotal(store)),
      items: store.items.map((item) => ({
        item_id: item.itemId,
        item_label: item.itemLabel,
        product_id: item.productId,
        product_name: item.productName,
        quantity: item.quantity,
        unit_price: money(item.unitCents),
        line_total: money(item.lineCents),
      })),
    })),
  };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) fail("expected JSON input on stdin");
  const normalized = normalize(JSON.parse(raw));
  const storeIds = [...normalized.stores.keys()].sort();
  const evaluated = combinations(storeIds, normalized.maxStores)
    .map((selection) => evaluate(normalized, selection))
    .filter(Boolean);

  const deduped = [...new Map(evaluated.map((option) => [option.signature, option])).values()]
    .sort((left, right) => left.totalCents - right.totalCents || left.stores.length - right.stores.length || left.etaMinutes - right.etaMinutes);
  const singles = deduped.filter((option) => option.stores.length === 1);
  const best = deduped[0] ?? null;
  const bestSingle = singles[0] ?? null;

  const result = {
    best_overall: present(best),
    best_single_store: present(bestSingle),
    split_savings: best && bestSingle ? money(bestSingle.totalCents - best.totalCents) : null,
    options: deduped.slice(0, MAX_RESULTS).map(present),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
  process.exitCode = 1;
});
