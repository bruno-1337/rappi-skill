# Product equivalence and basket comparison

## Candidate discovery

Search each requested item using the user's wording plus targeted variants when needed. Preserve the query that produced each candidate.

Establish equivalence in this order:

1. identical EAN;
2. identical brand, product line, variant, and net quantity;
3. compatible unit pricing with an explicitly accepted size difference;
4. semantic substitute, clearly labeled and never selected silently.

Normalize case, accents, punctuation, multiplication signs, and common units. Convert proven `kg/g`, `L/ml`, and package contents to comparable base quantities; do not infer contents solely from a title. `--quantity N`, result `quantity`, and `requested.units` always count listing units, not physical cans/bottles. Conflicting title and presentation counts require clarification before claiming a pack or converting listing units to physical units.

Exclude unavailable, out-of-stock, closed, out-of-coverage, prescription, and age-restricted candidates unless the user explicitly requests otherwise.

Search is bounded by the query, current location, response, filters, and result limit. Say “not found in these results,” not “no store sells it.” A quantity-only reply after multiple variants were offered does not select a SKU. Ask one combined quantity-and-variant question when both need resolution.

## Search decision schema

Compact search is the default: 10 results, one JSON row per result within structured JSON. Narrow the query rather than expanding a noisy response. There is no detail-output flag; [api.md](api.md#products-and-stores) describes additional upstream fields, not guaranteed CLI fields. The compact result contract is:

```text
{
  store_id, store_name, cart_type, product_id, name, description, presentation, ean,
  price, shipping_cost, minimum_order, eta, quantity, stock, minimum_units,
  available, age_restriction, requires_prescription,
  packaging: {
    status: 'single_indicated' | 'multiple_indicated' | 'conflicting' | 'unknown',
    title_units: number | null,
    presentation_units: number | null
  },
  requested: {
    units, item_subtotal, estimated_delivered, minimum_shortfall,
    feasible: boolean | null
  },
  alternative: null | {
    units, item_subtotal, estimated_delivered, requires_confirmation: true
  }
}
```

- Use `cart_type` for cart commands; do not substitute a retailer's `store_type`.
- `description` is sanitized menu text for restaurant products when Rappi supplies it; null means unavailable. Never infer ingredients or choose between generic names from titles alone.
- `packaging` reports textual signals, not verified physical contents. Even matching counts are not proof; `conflicting` is a clarification gate and `unknown` is not evidence of a single unit.
- `requested` evaluates the requested listing quantity as an **isolated basket**. Existing cart contents never reduce its shortfall. `item_subtotal` and `estimated_delivered` are search estimates, not a final checkout quote. Unknown price, shipping, minimum order, and stock remain null, not zero. Feasibility is false for a proven constraint violation, null when evidence is insufficient, and true only for a supported isolated-basket estimate—not an order guarantee.
- `minimum_units` constrains product quantity; `requested.minimum_shortfall` is the remaining store-level basket value. With `minimum_units: 1`, one unit may be addable even if the basket cannot check out below the store minimum.
- `alternative` may propose a different listing quantity only when proven quantity rules and known stock allow it. No regulated or weighted-goods quantity suggestions. Two listing units may be offered to meet a minimum; they are not two proven physical cans and are never applied without the user's confirmation.
- Compare requested quantities before separately offering alternatives. Do not prioritize larger packs solely because their higher price clears the minimum. Do not count extra units as requested, silently accept a size difference, add filler, or use an alternative to bypass variant selection.
- In `delivered` mode, comparable listings are ranked by their least known viable isolated-basket delivery estimate. A cheap single unit with a high store minimum must not hide a slightly pricier listing whose two-unit alternative is cheaper overall. The response still shows the exact requested quantity as unfulfilled until the user accepts an alternative.

## Effective product price

Use the price applicable to the requested listing quantity. When evidence is available, account for:

- `price` versus `real_price`;
- minimum promotional units;
- bundle/pay-X promotions;
- weighted goods and `sale_type`;
- minimum and step quantities;
- mandatory toppings or modifiers.

Show list price and savings separately only when supported. Do not count a promotion unless its conditions are met, or infer missing promotion, weight, or modifier rules from compact output. Unknown detail remains unknown; checkout recalculation is authoritative.

## Delivered basket total

For each store:

```text
item subtotal
- applicable discounts
+ delivery
+ service fee
+ mandatory charges
+ tip, if requested
= delivered total
```

Treat the search response's shipping cost as an estimate. The checkout recalculation is authoritative.

Produce at least:

- cheapest feasible single-store basket;
- cheapest feasible split basket up to the requested maximum number of stores;
- the savings or premium of splitting;
- unavailable items and uncertain substitutions.

A basket below a store's minimum order is infeasible at that composition. Do not invent filler or use unapproved pre-existing cart items to make it feasible. The optimizer evaluates the explicitly requested multi-item basket; per-result `requested` and `alternative` estimates remain isolated listing baskets.

## Optimizer input

After semantic equivalence is reviewed, send this shape to `scripts/optimize-basket.mjs` on stdin:

```json
{
  "max_stores": 2,
  "items": [
    {
      "id": "milk",
      "label": "Leite integral 1 L",
      "quantity": 2,
      "candidates": [
        {
          "store_id": "1",
          "store_name": "Market A",
          "product_id": "1_10",
          "product_name": "Leite integral 1 L",
          "unit_price": 5.5,
          "shipping_cost": 6.99,
          "service_fee": 0,
          "basket_discount": 0,
          "mandatory_charges": 0,
          "tip": 0,
          "minimum_order": 20,
          "eta_minutes": 35,
          "available": true
        }
      ]
    }
  ]
}
```

Money is BRL as decimal numbers in input and integer centavos internally. Repeat store-level cost fields on each candidate from that store; if values disagree, the optimizer conservatively keeps the highest costs and lowest discount. It searches item-to-store assignments needed to satisfy minimum orders rather than greedily assigning every item. Review the output before presenting it; checkout recalculation remains authoritative.