# Product equivalence and basket comparison

## Candidate discovery

Search each requested item using the user's wording plus targeted variants when needed. Preserve the query that produced each candidate.

Establish equivalence in this order:

1. identical EAN;
2. identical brand, product line, variant, and net quantity;
3. compatible unit pricing with an explicitly accepted size difference;
4. semantic substitute, clearly labeled and never selected silently.

Normalize case, accents, punctuation, multiplication signs, and common units. Convert `kg/g`, `L/ml`, and pack counts to base quantities. Do not infer net quantity solely from an ambiguous product name when structured fields disagree.

Exclude unavailable, out-of-stock, closed, out-of-coverage, prescription, and age-restricted candidates unless the user explicitly requests otherwise.

## Effective product price

Use the price applicable to the requested quantity. Account for:

- `price` versus `real_price`;
- minimum promotional units;
- bundle/pay-X promotions;
- weighted goods and `sale_type`;
- minimum and step quantities;
- mandatory toppings or modifiers.

Show list price and savings separately. Do not count a promotion unless its conditions are met.

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

A basket below a store's minimum order is infeasible. Do not invent filler.

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