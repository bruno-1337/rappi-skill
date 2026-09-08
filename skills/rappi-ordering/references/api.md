# Rappi Brazil API map

Observed against the Rappi Brazil web client on 2026-09-07. This is an internal, unsupported API and may change without notice. Base URL:

```text
https://services.rappi.com.br
```

The local CLI is the only supported caller. It protects the minimum authenticated request headers with Windows DPAPI or AES-256-GCM backed by macOS Keychain or Linux Secret Service, decrypts them only in command memory, fixes the service origin, and exposes operation-specific commands rather than an arbitrary API proxy.

`doctor` is the local-only exception: it reports setup diagnostics without contacting this API, reading credentials, or decrypting a session. Session-file presence and local setup readiness do not establish authentication.

## Request headers and session

Authenticated calls normally include:

```http
Authorization: Bearer <secret>
deviceid: <secret>
x-application-id: rappi-home-web/<live-version>
app-version: <live-version>
accept-language: pt-BR
needappsflyerid: false
accept: application/json
content-type: application/json
```

Checkout may additionally require browser-generated `af-web-id` and `cybs-fp-id`. `auth login` observes ordinary authenticated traffic briefly and retains these values when present. Never hard-code versions or identifiers, emit decrypted headers, or accept them through command-line arguments.

The session is unsupported internal API state and may expire or be revoked. HTTP 401/403 requires a fresh `auth login`. Never synthesize refresh tokens or retry a possibly accepted order.

## Account and location

```text
GET  /ms/application-user/auth
GET  /api/ms/rappi-prime/is-prime
GET  /api/ms/users-address/addresses
PUT  /api/ms/users-address/addresses/{addressId}/active
GET  /api/user-order-home/v3/orders
GET  /api/ms/rappi-credits-mongo/
```

Address records include `id`, `active`, `address`, `description`, `tag`, `lat`, `lng`, city, delivery instructions, and order count. Treat all of them as sensitive.

## Search

### Products and stores

```http
POST /api/pns-global-search-api/v1/unified-search?is_prime=false
```

```json
{
  "query": "leite integral",
  "lat": -22.0,
  "lng": -43.0
}
```

Relevant **upstream** response fields (not the CLI output contract):

```text
stores[]
  store_id, store_name, store_type, parent_store_type
  vertical_group, vertical_sub_group
  eta, eta_value, shipping_cost, mov, status, is_closed
  store_rating_score
  products[]
    id, product_id, master_product_id, ean, retail_id
    name, presentation, image
    price, real_price, balance_price
    discount, discount_type, discount_step, discounts
    sale_type, unit_type, pum
    stock, in_stock, is_available
    min_purchasing_units
    min_quantity_in_grams, step_quantity_in_grams, max_quantity_in_grams
    category_id, category_name, has_toppings
    age_restriction, requires_medical_prescription
```

Upstream `price` is the displayed listing-unit price; `real_price` is a reference/list price when supplied. Promotions with minimum units apply only when their conditions are proven for the requested listing quantity. These raw fields describe API evidence, not permission to call unsupported endpoints or bypass the helper.

For the final ranked restaurant candidates, the CLI enriches search rows from:

```http
GET /api/restaurant-bus/store/{storeId}/menu
```

It joins `corridors[].products[]` by compound product ID and sanitizes `description`. A missing product, omitted description, or unavailable menu leaves `description` as null rather than inventing contents.

### CLI search output

`search` defaults to compact results with a limit of 10. `--quantity N` requests listing units; it does not convert a title into a count of physical cans, bottles, or packs. Output remains structured JSON, with one compact JSON row per result; there is no detail-output flag. The exact result fields and nested types are documented in [comparison.md](comparison.md#search-decision-schema):

```text
store_id, store_name, cart_type, product_id, name, description, presentation, ean,
price, shipping_cost, minimum_order, eta, quantity, stock, minimum_units,
available, age_restriction, requires_prescription,
packaging: {status, title_units, presentation_units},
requested: {units, item_subtotal, estimated_delivered, minimum_shortfall, feasible},
alternative: null | {units, item_subtotal, estimated_delivered, requires_confirmation: true}
```

Use `cart_type`, not raw retailer `store_type`, in commands. Restaurant `description` is sanitized menu text when available and null otherwise; generic titles without a description do not establish a dish's ingredients. Unknown price, shipping cost, minimum order, and stock remain null rather than becoming zero. Estimates live under `requested` and `alternative`, not as top-level result cost fields. They evaluate an isolated listing basket without existing cart contents. `feasible: null` means unknown; true is not a final checkout guarantee.

Packaging counts are title/presentation signals, not verified contents. Conflicting signals require clarification. A non-null alternative only proposes a quantity supported by known rules and stock; it requires user confirmation and does not authorize automatic mutation. It is not offered for regulated or weighted goods.

### Suggestions and history

```text
POST /api/pns-global-search-api/v1/unified-suggestions
POST /api/pns-global-search-api/v1/unified-favorite-stores
POST /api/pns-global-search-api/v1/unified-recent-top-searches
```

Suggestion body:

```json
{
  "keyword": "leite",
  "lat": -22.0,
  "lng": -43.0,
  "suggester_type": "global",
  "parent_store_type": "market"
}
```

`parent_store_type` is conditional.

## Store discovery and availability

```http
GET /api/web-gateway/web/availability/stores/{storeId}/zone/?lat={lat}&lng={lng}
```

Relevant fields include `is_open`, `is_currently_available`, `in_coverage`, `shipping_cost`, `delivery_price`, `percentage_service_fee`, `eta`, `distance`, `max_quantity`, `sku_limits`, `schedule_operation`, and `available_slots`.

Dynamic store content:

```http
POST /api/web-gateway/web/dynamic/context/content/
```

```json
{
  "limit": 20,
  "offset": 0,
  "state": {
    "lat": "-22.0",
    "lng": "-43.0",
    "parent_store_type": "market"
  },
  "stores": [123456],
  "context": "<context>"
}
```

Prefer unified search for product comparison. Dynamic content is component-oriented and more fragile.

## Cart

Read all carts:

```http
POST /api/ms/shopping-cart/v1/all/get

{}
```

Replace/update a store cart:

```http
PUT /api/ms/shopping-cart/v2/{storeType}/store
```

Body is an array:

```json
[
  {
    "id": 123456,
    "products": [
      {
        "id": "123456_7890",
        "units": 1,
        "sale_type": "U",
        "comment": "",
        "nodeId": "optional",
        "corridorId": "optional",
        "toppings": [
          {
            "id": 11,
            "node_id": 22,
            "topping_parent_id": 33,
            "topping_category_id": 44,
            "description": "option name",
            "price": 0,
            "units": 1
          }
        ]
      }
    ]
  }
]
```

Send the complete desired store state. Read the current cart first, modify it, and preserve fields required by existing products. Product IDs normally use the compound `storeId_productId` form.

Additional cart operations:

```text
DELETE /api/ms/shopping-cart/v1/all/stores
GET    /api/cpgs-cart/store_type/{storeType}
POST   /api/ms/shopping-cart/v1/{storeType}/change-address
```

Change-address body:

```json
{ "id": 123, "lat": -22.0, "lng": -43.0 }
```

## Checkout preview

```text
POST /api/ms/shopping-cart/v1/{storeType}/recalculate
GET  /api/ms/shopping-cart/v1/{storeType}/checkout/detail
GET  /api/ms/shopping-cart/v1/{storeType}/summary-v2
POST /api/ms/checkout-component/{storeType}
GET  /api/ms/core-tip/user-segmentation?store_type_group={storeType}&store_type={storeType}&store_id={storeId}
GET  /api/ms/payment-method/resolver/v5?origin=APP&store_type={storeType}&store_id={storeId}
```

Recalculate body used for final preparation:

```json
{}
```

Checkout-component body:

```json
{
  "delivery_method": "delivery",
  "scheduled": false,
  "store_ids": [123456]
}
```

The payment resolver uses uppercase `origin=APP`; `zone_id` and `zone_name` are included from the active address when available. Saved-card selection uses `PUT /api/ms/shopping-cart/v1/{storeType}/payment-method` with the exact resolver metadata held only in process memory. Never expose full payment credentials, internal account IDs, tokens, or raw resolver payloads.

## Place order

```http
POST /api/ms/shopping-cart-proxy/{storeType}/checkout
```

The current Brazilian client sends the complete `data` returned by:

```http
POST /api/ms/shopping-cart/v1/{storeType}/recalculate
{}
```

Do not reduce this to `{ "return_key": ... }`. Commit uses the current OS-protected session headers and sets `needAppsFlyerId: true`; it carries captured `af-web-id` and `cybs-fp-id` only when the official client emitted them during authentication bootstrap. Never invent antifraud identifiers.

Never call this endpoint during discovery, testing, or preview.