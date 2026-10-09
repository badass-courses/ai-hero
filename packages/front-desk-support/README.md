# @ai-hero/front-desk-support

Thin Next.js facade for front-desk's read-only support RPC.

```ts
export const { GET, POST } = createFrontDeskHandler(hooks, {
	apiKey: env.FRONT_DESK_API_KEY,
})
```

- The app supplies four async read hooks: `customerByEmail`, `purchasesForUser`, `chargeState`, and `pricingFacts`. They use the app's own database and Stripe key.
- Internally this is an Effect RPC group (`effect/rpc`, `RpcServer.toHttpEffect`, JSON serialization). `pnpm build` bundles effect 4.0.2 into one ESM file, `dist/index.js`. Only `node:crypto` stays external, and `test/bundle.test.mjs` enforces that. The public types are plain TypeScript.
- Auth: `Authorization: Bearer <key>`, compared as constant-time SHA-256 digests. A missing or wrong key gets 401 with an empty body. An unset key gets 503. A read uses `POST`, and an authenticated `GET` gets 405.
- Errors carry only codes: `HOOK_FAILED`, `INVALID_HOOK_RESULT`, `PRODUCT_NOT_SUPPORTED`, `INVALID_REQUEST`. Hook exceptions, decode issues, and request values never appear in the response.
- v0 has no writes.

## pricingFacts

`pricingFacts({ email, productId, quantity, orderKind })` is read-only evidence for front-desk's pricing. It returns buyer facts, the product's single active merchant price (ID and whole US cents), and the IDs and refs behind them. Each fact is `{ value, sourceRefs }` or `{ gap }`, where a gap is `FactsUnavailable`, `IdentityUnverified`, or `PaymentAmbiguous`. A source that cannot answer becomes a gap, never an empty history.

This repo computes no price and holds no pricing policy. front-desk owns the rules and calls this RPC. The `PricingBuyerFacts` type is a structural copy of the fields front-desk reads, nothing more. The facade decodes hook output against it, drops anything extra, and fails with `INVALID_HOOK_RESULT` if the facts answer a different product, quantity, or order kind. A product the app reports no facts for fails with `PRODUCT_NOT_SUPPORTED`.

Bounds match front-desk's refinements: credit cents are nonnegative safe integers, order quantity is 1 to 10,000, existing seats are 0 to 100,000, and a PPP percent is 0 to 100.

The shared compatibility fixtures are `test/fixtures/pricing-facts.json`, one full response, and `test/fixtures/buyer-facts-boundaries.json`, cases marked `valid` or not. They cover max seats, every gap kind, unavailable facts, and out-of-range values. `test/pricing-facts.test.ts` checks both here, and front-desk can decode each `facts` with its own `BuyerFacts` schema.

The app reports facts only where it has evidence:

- An email with no exact account match is `IdentityUnverified` for ownership facts. It is never treated as an empty history.
- A Crash Course credit is the matching product line on the purchase's own Checkout Session, less tax, from a paid, captured, succeeded charge. If any link is missing, the credit is `PaymentAmbiguous`.
- Credit use holds for any individual purchase of the target product the buyer holds or ever transferred away, until a redemption ledger exists. A Crash Course purchase that arrived by transfer holds the credit, because its previous owner may have spent it. If transfer history cannot be read, both credit facts are `FactsUnavailable`.

Wire format, one request per POST:

```json
{ "_tag": "Request", "id": "1", "tag": "customerByEmail", "payload": { "email": "..." }, "headers": [] }
```
