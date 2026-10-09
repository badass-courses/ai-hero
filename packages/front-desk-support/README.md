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

`test/fixtures/pricing-facts.json` is the shared compatibility fixture. `test/pricing-facts.test.ts` decodes it here, and front-desk decodes the same file with its own `BuyerFacts` schema.

Wire format, one request per POST:

```json
{ "_tag": "Request", "id": "1", "tag": "customerByEmail", "payload": { "email": "..." }, "headers": [] }
```
