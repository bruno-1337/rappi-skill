# API-first operating procedure

The connector repo is two parent directories above this skill's resolved filesystem path. Never use a `skill://` URI as `cwd`. Resolve Bun to an absolute executable path for supervised processes because they may not load the shell's `PATH`. On a fresh clone, run `bun install` and only then `bun run setup`; use the repo as `cwd` for all commands.

## Authentication bootstrap

Normal commands use the encrypted API session and do not require a running browser.

```text
auth status
auth login
auth clear
```

`auth login` is the complete bootstrap flow. It opens a dedicated persistent Chromium profile on official `https://www.rappi.com.br/`, waits up to ten minutes for the user to finish authentication, requires a successful 2xx response from the official authenticated user endpoint, protects only the required request headers with the OS credential store, and closes Chromium. It prints `RAPPI_AUTH_READY` only after the protected session is written.

State outside the repo:

| Platform | Directory |
|---|---|
| Windows | `%LOCALAPPDATA%/RappiConnector` |
| macOS | `~/Library/Application Support/RappiConnector` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/rappi-connector` |

Windows encrypts records directly with DPAPI. macOS and Linux encrypt records with AES-256-GCM and keep the random master key in Keychain or Secret Service. Linux requires `secret-tool`. All protected files and browser profiles remain sensitive local state: never inspect, copy, commit, upload, display, or pass their decrypted contents through arguments. `auth clear` deletes the saved session. Session expiry and revocation still apply; on HTTP 401/403 run `auth login` again. Do not replay a possibly accepted mutation or checkout after reauthentication.


## Helper boundary

Every supported operation goes through the CLI. Do not duplicate its API calls in browser automation or ad-hoc scripts.

The client:

- fixes the production origin to `https://services.rappi.com.br`;
- exposes no arbitrary path or proxy command;
- validates identifiers, store types, quantities, money, and response shapes;
- JSON-encodes request bodies;
- rejects redirects and unsafe paths;
- enforces request timeouts and a 20 MiB response limit;
- strips C0/C1 and escape controls from remote strings;
- never retries mutations or checkout automatically.

## Search and comparison

```text
search <query...> --sort price|fastest|delivered --limit N --quantity N
search <query...> --ean <EAN>
```

The helper loads the active location internally without printing coordinates. It removes unrelated broad-search suggestions, deduplicates store/product pairs, excludes unavailable results by default, parses immediate ETA ranges, calculates item subtotal, estimated delivered cost, and minimum-order shortfall, then ranks deterministically.

`estimated_delivered` includes the search response's delivery estimate only. Checkout recalculation remains authoritative for discounts, service fees, mandatory charges, tip, and final timing.

## Addresses

```text
addresses list
addresses set <address-id>
```

Listing returns IDs, active state, labels, and non-sensitive city text only. Setting an address performs the PUT and reads addresses again; success requires that exact ID to be active. Never change it without a clear user request.

## Orders

```text
orders list
```

Returns sanitized order ID, store, amount, state, and creation time when present. It is also the reconciliation source after checkout.

## Cart

```text
cart get
cart add --query <fresh-query> --store-type <cart_type> --store-id <id> --product-id <id> --units <n>
cart remove --store-type <cart_type> --store-id <id> --product-id <id>
```

`cart add` performs a fresh search and accepts only an exact currently available store/product pair. Use `cart_type` returned by search. It rejects regulated and prescription products and quantities below product minimums.

Do not mutate the cart until the requested product resolves to one exact SKU. When multiple flavors, sizes, formulations, or other variants remain plausible, present the choices and ask the user to select one. A quantity-only follow-up after listing alternatives does not disambiguate the product.

Mutation sequence:

1. `POST /api/ms/shopping-cart/v1/all/get` with `{}`.
2. Preserve the complete existing cart/store/product data.
3. Change only the selected product quantity.
4. `PUT /api/ms/shopping-cart/v2/{cart_type}/store` with the complete desired store array.
5. Read all carts again.
6. Require exact product/quantity readback before reporting success.

Unexpected cart shapes fail closed. Never invent filler or substitutions.

Cart types must be proven by the returned discriminator. A retailer label such as `venancio` is not automatically `market`, even if only one store exists. Unsupported mappings fail closed; do not change CLI code or invent a type during shopping to bypass that error.

### Mandatory whole-cart authorization check

Before `checkout approve`, run `cart get` and compare the complete cart—not only the products changed during this task—with the exact basket authorized by the user's requests in the current conversation.

- Match every store ID, product ID, and quantity.
- Treat every pre-existing item as unapproved unless the user explicitly requested that exact product and quantity.
- An extra store, extra product, duplicate, higher quantity, or unidentified entry is a hard stop.
- Report the mismatch and ask the user whether to remove or retain it. Never remove or retain it by assumption.
- After any correction, run `cart get` again and require an exact match.

Never create an approval or invoke `order` while the cart contains anything outside the explicitly authorized basket. The approval snapshot prevents later cart drift, but it does not make an unreviewed pre-existing item authorized.

## Saved payment selection

```text
payments list --store-type <cart_type> --store-id <id>
payments select --store-type <cart_type> --store-id <id> --alias <saved-card-alias>
```

`payments list` returns only masked card metadata and safe method labels. `payments select` is a reversible account mutation: run it only after the user clearly names one saved-card alias, require exactly one available match, reject cards requiring CVV or interactive verification, send sensitive resolver metadata only in memory, and require exact server readback. Never expose internal payment IDs, tokens, full card numbers, cardholder data, or resolver payloads.

## Checkout preview

```text
checkout preview --store-type <cart_type>
```

The helper reads the cart and active address, then calls:

```text
POST /api/ms/shopping-cart/v1/{cart_type}/recalculate
GET  /api/ms/shopping-cart/v1/{cart_type}/checkout/detail
GET  /api/ms/shopping-cart/v1/{cart_type}/summary-v2
POST /api/ms/checkout-component/{cart_type}
GET  /api/ms/core-tip/user-segmentation?store_type_group={cart_type}&store_type={cart_type}&store_id={store_id}
GET  /api/ms/payment-method/resolver/v5?origin=APP&store_type={cart_type}&store_id={store_id}
```

It builds a canonical material snapshot containing exact store/product IDs, quantities, per-store totals, aggregate subtotal, discounts, delivery, service fee, mandatory charges, selected tip, final total in integer centavos, address ID/label, delivery window, and masked payment method. Context hashes exclude only the recalculation's top-level request timestamp and renewed `charge_data.threeds_reference_id` values. Suggested-tip marketing content is not an approved choice; the selected tip amount is bound instead. All other recalculation and payment-resolver fields remain bound. The fresh original payload is submitted unchanged after approval validation; normalization never modifies payment challenges or bypasses their verification.

Multi-store checkout fails closed unless the API exposes a verifiable total for every store and every per-store amount sums exactly to its aggregate.

## Approval and commit

```text
checkout approve --store-type <cart_type>
checkout cancel <approval-id>
order --store-type <cart_type> --approval-id <approval-id>
```

`checkout approve` recalculates checkout and writes a ten-minute OS-protected approval record. The returned short hash is for the user's confirmation prompt; never show the full hash.

After explicit confirmation, `order`:

1. recalculates all checkout state;
2. claims and consumes the approval with an atomic filesystem lock before any order request;
3. requires exact canonical snapshot and all context-hash equality;
   A mismatch reports the changed snapshot fields, not sensitive values. Do not repeatedly request confirmation without investigating the reported differences.
4. posts the complete fresh recalculation response to `/api/ms/shopping-cart-proxy/{cart_type}/checkout` once;
5. collects explicitly identified order IDs and compares status against a pre-submission order baseline;
6. polls current orders up to eight times, three seconds apart, even after a missing ID or response error;
7. reports `confirmed` only when every returned ID maps exactly once to an approved store and amount. `created_unverified` means returned IDs are listed but financial verification is incomplete. Without returned IDs, newly observed orders are only candidates, never an inferred confirmation.

Concurrent order attempts cannot reuse an approval. A mismatch, expiry, crash, failed verification, or reconciliation read failure consumes it and requires investigation; never replay a checkout that may have been accepted.

## Ambiguous outcome

A checkout request that loses the response is marked ambiguous and is never retried. Query orders and compare IDs, store IDs, amounts, and time. Cart state or absence from an early order read does not prove non-placement. A new user approval alone does not make replay safe.

The home order feed can omit store IDs and monetary totals; unknown values remain null. Its contents may also lag checkout. A status-read error or exit code 2 after submission is not a declined payment. Read-only follow-up is allowed, but another checkout is not. The CLI performs bounded waiting internally with portable timers, not the Windows `timeout` command.

## Scope boundaries

- Never silently substitute a product.
- Never add filler to meet minimum order.
- Never change address, tip, delivery window, or payment as a side effect.
- Never use generic cart helpers for regulated goods.
- Never call telemetry, advertising, credits, coupon redemption, debt-payment, billing-profile, or fraud endpoints.
