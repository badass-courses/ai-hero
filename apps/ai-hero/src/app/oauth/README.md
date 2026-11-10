# OAuth 2.0 Device Flow / Minimal OIDC Surface for Next.js 15

This README is **the single source of truth** for how the `/oauth` directory implements a pared-down OAuth 2.0 Device Authorization Grant plus just enough OIDC to make it useful. It is intentionally opinionated and pragmatic so that a "junior" (or very dumb) LLM agent can **fully reproduce the implementation** in any Next.js 15 project.

## Table of Contents

1. High-level architecture
2. Runtime & framework assumptions
3. Environment variables
4. Database schema & the *Service Interface* abstraction layer
5. Endpoint catalogue
6. End-to-end happy path walk-through
7. Error cases & edge conditions
8. Extending / hardening the implementation

---

## 1. High-level architecture

```
       ┌──────────────┐                         ┌──────────────┐
       │  Third-Party │                         │    Browser   │
       │    Device    │                         │ (activates)  │
       └──────┬───────┘                         └──────┬───────┘
              │                                        │
              │ 1. POST /oauth/device/code             │
              │────────────────────────────────────────▶│
              │ ◀───────────────────────────────────────│
              │   user_code + device_code              │
              │                                        │
              │                                        │ 2. User visits /activate
              │                                        │    and enters user_code
              │                                        │
              │ 3. Device polls /oauth/token           │
              │   (every `interval` seconds)           │
              │────────────────────────────────────────▶│
              │ ◀───────────────────────────────────────│
              │  a. 403 `authorization_pending` until  │
              │     browser verifies the code          │
              │  b. 200 access_token when verified     │
              │                                        │
              │ 4. Device calls /oauth/userinfo        │
              │    with Bearer access_token            │
              │────────────────────────────────────────▶│
              │ ◀───────────────────────────────────────│
              │    user profile JSON                   │
```

*All endpoints are **Route Handlers**—in Next.js 15 they always run on the server and can tap directly into your database and other backend services.*

---

## 2. Runtime & framework assumptions

* Next.js **15.0.0-canary** or newer with the default /app router.
* `fetch` API / `Request`, `Response`, `Headers`—no Express.
* ESM (`.ts` or `.mjs` modules, `"type": "module"` where needed).
* **Drizzle ORM** is used in this particular repo, **but the core logic is isolated behind a `PersistenceService` interface** (see next section) so you can swap in Prisma, Kysely, Postgres.js, etc.

---

## 3. Environment variables

| Variable               | Purpose                                         |
|------------------------|-------------------------------------------------|
| `NEXT_PUBLIC_URL`      | Absolute public URL for the app (e.g. `https://example.com`). Used to build the issuer and endpoint URLs exposed by OIDC `.well-known` config. |

> **NOTE** `NEXT_PUBLIC_URL` is consumed **inside the server runtime** but prefixed with `NEXT_PUBLIC_` so that client bundles can also reference it if necessary.

---

## 4. Database schema & *Service Interface*

### 4.1 Raw tables (Drizzle ORM flavour)

| Table                  | Key columns / Purpose                     |
|------------------------|-------------------------------------------|
| `users`                | `id`, `email`, …                          |
| `device_verifications` | `deviceCode`, `userCode`, `expires`, `verifiedAt`, `verifiedByUserId` |
| `device_access_token`  | `token`, `userId`, `createdAt`            |

### 4.2 `PersistenceService` (must-implement contract)

```ts
// packages/auth-core/src/persistence-service.ts
export interface PersistenceService {
  /* Device Verification */
  createDeviceVerification(device: {
    deviceCode: string
    userCode: string
    expires: Date
  }): Promise<void>
  getDeviceVerification(deviceCode: string): Promise<DeviceVerification | null>
  verifyDevice(params: {
    deviceCode: string
    userId: string
  }): Promise<void>
  deleteDeviceVerification(deviceCode: string): Promise<void>

  /* Access Tokens */
  createAccessToken(userId: string): Promise<DeviceAccessToken>
  getAccessToken(token: string): Promise<DeviceAccessToken | null>

  /* Users */
  getUser(userId: string): Promise<User | null>
}
```

A **Drizzle implementation** lives in `apps/ai-hero/src/app/oauth/persistence/drizzle-service.ts` (to be created). Other apps can wire their own.

> The route handlers *never* import the ORM directly—only the `PersistenceService`.

---

## 5. Endpoint catalogue

### 5.1 `/.well-known/openid-configuration`
*Method:* `GET`

Returns the minimal set of OIDC discovery metadata needed by clients:

```jsonc
{
  "token_endpoint": "https://EXAMPLE/oauth/token",
  "response_types_supported": ["token"],
  "scopes_supported": ["content:read", "progress"],
  "issuer": "https://EXAMPLE/oauth",
  "registration_endpoint": "https://EXAMPLE/oauth/register",
  "device_authorization_endpoint": "https://EXAMPLE/oauth/device/code",
  "claims_supported": ["email"],
  "userinfo_endpoint": "https://EXAMPLE/oauth/userinfo"
}
```

### 5.2 `/oauth/register`
*Method:* `POST`

Public client registration (opaque demo only):

```jsonc
{
  "client_id": "ABC123",
  "client_secret": "DEF456"
}
```

### 5.3 `/oauth/device/code`
*Method:* `POST`

Client hits this to start the Device Flow.

Request body: *none* (could accept scope & client_id but ignored here).

Response:

```jsonc
{
  "device_code": "550e8400-e29b-41d4-a716-446655440000",
  "user_code": "lively-koala-7",
  "verification_uri": "https://EXAMPLE/activate",
  "verification_uri_complete": "https://EXAMPLE/activate?user_code=lively-koala-7",
  "expires_in": 600,
  "interval": 5
}
```

The handler:
1. Generates codes (`uuid.v4` + `human-readable-ids`).
2. Persists them via `PersistenceService.createDeviceVerification`.
3. Returns the payload above.

### 5.4 `/oauth/token`
*Method:* `POST` (form-url-encoded)

```
client_id     = DEMO-ONLY ← ignored
device_code   = *required*
```

Responses:

| HTTP | Body (`application/json`) | When                                   |
|------|---------------------------|----------------------------------------|
| 403  | `{ "error": "authorization_pending" }` | Device not yet verified. Retry after `interval`. |
| 403  | `{ "error": "expired_token" }` | User never verified within 10-min window. |
| 403  | `{ "error": "access_denied" }` | Bad `device_code` or internal failures. |
| 200  | `{ "access_token": "…", "token_type": "bearer", "scope": "content:read progress" }` | Success! |

### 5.5 `/oauth/userinfo`
*Method:* `GET`

Requires header `Authorization: Bearer <access_token>`.

* 200 OK ⇒ user JSON as stored in DB.
* 404 Not Found ⇒ token exists but user deleted.
* 403 Forbidden ⇒ token not found.

---

## 6. End-to-end happy path walk-through

1. *Device* calls `/oauth/device/code` and receives `user_code = lively-koala-7`, `device_code = 550e…`.
2. *User* on laptop/phone visits `https://EXAMPLE/activate` (UI outside the scope of this directory) and enters `lively-koala-7`.
3. UI validates the code → sets `verifiedAt = now`, `verifiedByUserId = <user.id>` via `PersistenceService.verifyDevice`.
4. *Device* polls `/oauth/token` (every 5 seconds recommended) with `device_code`.
5. Once verified, server creates a row in `device_access_token`, deletes the verification row, and returns the token.
6. *Device* hits `/oauth/userinfo` with the token whenever it needs the user profile.

---

## 7. Error cases & edge conditions

* **Clock skew** – all timestamps are server-side so clients don't need to agree.
* **Replay attacks** – `device_code` is deleted after first successful token issue.
* **Token revocation** – not implemented; easiest path is to delete the `device_access_token` row.
* **Scope handling** – hard-coded to `content:read progress`; adapt as needed.

---

## 8. Extending / hardening the implementation

* Swap in **JWT access tokens** (`jose` + JWKS) instead of opaque DB tokens.
* Add **PKCE** to the Device Flow (optional per RFC 8628).
* Implement **rate limiting** on `/oauth/token` polling.
* Add **/activate** web UI & server actions.
* Instrument with `@coursebuilder/logger` for observability.

---

## 9. Learner MCP sign-in: authorization code with PKCE

The learner MCP server (`/mcp`) also signs learners in with OAuth 2.1, alongside the device flow above. The device flow, `/oauth/userinfo` and the CLI are unchanged.

* Discovery: `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and `/.well-known/oauth-authorization-server/oauth` (RFC 8414).
* `GET /oauth/authorize` validates, sends a signed-out learner to `/login`, then shows the consent page at `/oauth/authorize/consent`; Approve or Deny posts to `/oauth/authorize/decision`.
* `POST /oauth/token` with `grant_type=authorization_code` trades a 60-second, single-use code and its PKCE verifier for a `learner:read` token (90 days, no refresh). Any other request is the device flow.
* `POST /oauth/register` with `redirect_uris` returns a stateless public client; without them, the demo response above.
* `POST /oauth/revoke` (RFC 7009) revokes `learner:read` tokens only.
* Code: `src/lib/learner-agent/oauth/`. The CIMD fetcher there (`cimd-fetch.ts`) is the SSRF surface.

---

### TL;DR for the LLM agent

1. Create the tables or alternative persistence according to §4.
2. Implement the five endpoints from §5 calling a `PersistenceService` rather than raw ORM.
3. Follow the sequences in §6 and handle the errors in §7.
4. Keep the code ESM, Server-only, and covered by unit tests.

Now go forth and ship it. 💥
