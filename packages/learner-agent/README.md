# @ai-hero/learner-agent

The learner agent surface: what an enrolled learner's own agent can do with AI Hero, as one Effect v4 contract per capability, projected to MCP, HTTP and OpenAPI.

The app serves it at `/mcp` and `/api/learner/<tool>`. This package owns the contracts, the dispatcher and the projections; the app owns identity, entitlements, content loading and logging, and hands them in as ports.

## Boundary

`makeLearnerAgent(ports)` returns `{ handleMcp, handleHttp, invoke }`. Ports are plain Promise functions over plain types (`src/ports.ts`), so a caller on another Effect major imports no Effect types. Each call runs its own runtime; nothing outlives the request.

A rejected port becomes a typed `Unavailable` and calls `onPortFailure`. An unexpected failure is a 500 and calls `onDefect`.

## Capabilities

All read-only in this cut, in recommended order (`src/capabilities.ts`):

- `my_courses`: what the learner owns, with workshop open dates
- `course_outline`: sections and lessons with the learner's completion; unopened workshops show title and date only
- `read_lesson`: lesson body, transcript and session extract; the solution only when asked
- `session_extract`: the session extract, optionally windowed at a video second
- `search_course`: search, with hits the learner can read marked
- `office_hours`: upcoming live sessions for owned cohorts
- `next_offer`: the learner's current offer, priced live by the app's checkout rules; no price for a learner who owns it

Failures are tagged errors (`src/errors.ts`) carrying `next_actions`. Output is encoded through each contract's schema, so a field the schema does not name never leaves.

One prompt, `start_lesson` (`src/prompts.ts`), frames a lesson with study-companion rules and never includes the solution.

## Adding a capability

1. Define its contract with `defineContract` in `src/capabilities/`.
2. Implement it with `implement` against the services in `src/services.ts`.
3. Add it to the tuple in `src/capabilities.ts`. MCP, HTTP, OpenAPI and the catalog pick it up from there.

## Build and test

```sh
pnpm --filter @ai-hero/learner-agent build
pnpm --filter @ai-hero/learner-agent test
```

The app builds this package in its `prebuild`, `pretypecheck` and `pretest`.
