# AI Hero

Monorepo for [aihero.dev](https://www.aihero.dev) — courses, skills, and posts on AI engineering by Matt Pocock.

The app lives in [`apps/ai-hero`](./apps/ai-hero) (see its [README](./apps/ai-hero/README.md) for local setup); shared packages sit under [`packages/`](./packages).

## API

The public API is self-describing:

- **OpenAPI 3.1 document**: [aihero.dev/api/openapi.json](https://www.aihero.dev/api/openapi.json) — every operation with request/response schemas, required token scopes, and agent-token policies
- **Discovery document**: [aihero.dev/api](https://www.aihero.dev/api) — route families, agent capabilities, and next actions in plain JSON

Both are generated from the same code that serves the routes, so they are always current. Authentication and usage examples live in the [app README](./apps/ai-hero/README.md#api-documentation).
