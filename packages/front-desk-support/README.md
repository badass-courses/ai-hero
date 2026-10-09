# @ai-hero/front-desk-support

Thin Next.js facade for front-desk's read-only support RPC.

```ts
export const { GET, POST } = createFrontDeskHandler(hooks, {
	apiKey: env.FRONT_DESK_API_KEY,
})
```

- The app supplies three async read hooks: `customerByEmail`, `purchasesForUser`, and `chargeState`. They use the app's own database and Stripe key.
- Internally this is an Effect RPC group (`effect/rpc`, `RpcServer.toHttpEffect`, JSON serialization). `pnpm build` bundles effect 4.0.2 into one ESM file, `dist/index.js`. Only `node:crypto` stays external, and `test/bundle.test.mjs` enforces that. The public types are plain TypeScript.
- Auth: `Authorization: Bearer <key>`, compared as constant-time SHA-256 digests. A missing or wrong key gets 401 with an empty body. An unset key gets 503. A read uses `POST`, and an authenticated `GET` gets 405.
- Errors carry only codes: `HOOK_FAILED`, `INVALID_HOOK_RESULT`, `INVALID_REQUEST`. Hook exceptions, decode issues, and request values never appear in the response.
- v0 has no writes.

Wire format, one request per POST:

```json
{ "_tag": "Request", "id": "1", "tag": "customerByEmail", "payload": { "email": "..." }, "headers": [] }
```
