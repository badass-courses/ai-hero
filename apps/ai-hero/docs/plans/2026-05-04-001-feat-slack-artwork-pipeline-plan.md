---
title: 'feat: Slack-mediated generative artwork pipeline for posts'
type: feat
status: active
date: 2026-05-04
origin: apps/ai-hero/docs/brainstorms/2026-05-04-slack-artwork-pipeline-requirements.md
---

# feat: Slack-mediated generative artwork pipeline for posts

## Summary

Extends existing Inngest + Cloudinary patterns and clones the existing Slack signature-verification pattern to build a post → Slack-notify → Generate-on-click → fal LoRA → variant-pick loop. Net-new: `@fal-ai/client`, three new app routes (Slack interactivity, Slack slash command, fal webhook), one new `coverImage` field on PostSchema (plus a namespaced `_artwork` pipeline-private field), seven new Inngest functions chained via namespaced events. **No image post-processing in v1** — fal output is shown in Slack as-is and only the picked variant is uploaded to Cloudinary. Compositing/branding is deferred to dynamic OG routes. Two rapid-test triggers (CLI script + `/artwork` slash command) let the loop be exercised against any existing post without writing new DB records. Uses a dedicated content-bot Slack app (separate token + signing secret from the existing `kit-broadcast-approval` bot) to avoid coupling lifecycles.

---

## Problem Frame

Posts ship without cover art today and the brand-side LoRA pipeline (v9, in `aihero-design/lora-training/`) has never been wired into the live aihero app. Vojta wants a Slack-mediated workspace to iterate on artwork against real posts, with zero back-pressure on Matt's API publishing flow. See origin: `apps/ai-hero/docs/brainstorms/2026-05-04-slack-artwork-pipeline-requirements.md` for the full pain narrative and decision rationale.

---

## Requirements

**Notification (post → Slack)**
- R1. Bot posts a Slack message to a new dedicated channel (`SLACK_CONTENT_CHANNEL_ID`) for every `RESOURCE_CREATED` where `data.type === 'post'`. (origin: R1)
- R2. Notification includes title, slug, post type, link to the editor, plus `Generate Artwork` and `Skip` buttons. (origin: R2)
- R3. Notifications persist as a backlog; the bot updates them in place to a terminal state on action. (origin: R3)

**Generation (click → variants)**
- R4. Generation only runs on a button click (Generate or Regenerate) or a manual replay trigger. No auto-generation. (origin: R4)
- R5. Each generation produces 4 variants. (origin: R5)
- R6. The image prompt is constructed by an LLM from the post's serialized markdown; the LLM returns only the visual-noun hook descriptor. (origin: R6)
- R7. fal.ai generation uses the trained v9 LoRA whose URL lives in `FAL_LORA_URL`; swappable via env without code change. (origin: R7)
- R8. Variants are shown in Slack as-is from fal output (no post-processing). The picked variant is uploaded to Cloudinary unmodified and used as the cover. Composition/branding (e.g., the OG strip + foreground PNG from `aihero-design/lora-training/og_articles_v9.py`) is deferred to a future dynamic OG route layer. (simplified from origin: R8)

**Pick (variant → post cover)**
- R9. Picking a variant uploads the raw fal image to Cloudinary, producing a stable `secure_url`. (origin: R9)
- R10. The Cloudinary URL is written to `post.fields.coverImage.url` via direct call to `courseBuilderAdapter.updateContentResourceFields`. (origin: R10)
- R11. The notification includes a "cover already set" indicator when applicable, and Pick always overwrites. The check is informational and reads the post's current state at click-time, not notification-fire-time. (origin: R11)

**Failure handling**
- R12. Claude/fal/Cloudinary failures surface in the Slack thread with a Retry button; the post is never modified on generation or upload failure. (origin: R12)

**Slack interactivity infrastructure**
- R13. A single signing-secret-verified HTTP endpoint at `/api/slack/interactivity` parses button payloads and dispatches namespaced Inngest events. The endpoint never does pipeline work inline. (origin: R13)
- R14. Channel membership IS access control. No per-user identity check. (origin: R14)

**Rapid-test triggers** (added during planning)
- R15. A CLI script in `apps/ai-hero/scripts/` accepts a slug and fires the same Inngest event the post-create path emits, allowing iteration against any existing post without DB writes.
- R16. A Slack slash command `/artwork <post-url-or-slug>` does the same from anywhere with Slack access. Accepts full URLs (`/<slug>`, `/md/<slug>`) or bare slugs. Lives at a separate route `/api/slack/commands`.
- R17. Both replay triggers bypass the in-flight `artworkGenerationStartedAt` guard and the "cover already set" warning so the same post can be regenerated freely.

**Origin actors:** A1 (Matt — post author), A2 (Vojta — artwork curator), A3 (artwork bot), A4 (fal), A5 (LLM via AI SDK gateway), A6 (Cloudinary)
**Origin flows:** F1 (notify-on-post-created), F2 (generate-on-click), F3 (pick-variant), F4 (regenerate)
**Origin acceptance examples:** AE1 (covers R1, R2), AE2 (covers R4–R8), AE3 (covers R9, R10), AE4 (covers R11), AE5 (covers R12), AE6 (covers R14)

---

## Scope Boundaries

- Auto-generation on post create — gated behind a click. (origin)
- Resource types other than posts (lessons, workshops, cohorts, lists, embeds). (origin)
- Editing the LLM-generated hook descriptor from inside Slack before regen. (origin)
- Persisting un-picked variant URLs on the post. (origin)
- Per-day / per-month fal cost caps. (origin)
- Web UI for picking variants — Slack only. (origin)
- API response surfacing of pending artwork. (origin)
- Slack user → aihero user identity mapping. (origin)

### Deferred to Follow-Up Work

- **Image composition / OG branding (foreground PNG, smart-crop strip)**: v1 ships raw fal output as the cover. When we want branded OG, do it in a dynamic OG route (`src/app/api/og/...`) that takes the picked Cloudinary URL and composites the foreground at request time — no in-pipeline `sharp` step, no foreground asset committed to this app.
- **Coalescing or rate-limiting notifications during batch imports**: deferred until we observe whether batch-import scenarios are realistic in practice.
- **DB-backed (vs env-var) LoRA model config**: env var is fine for v1; revisit when multiple active LoRAs need per-call selection.
- **Refactoring the existing `kit-broadcast-approval` route to use the extracted signature-verification helper**: separate cleanup PR after this lands and the helper has settled.
- **Updating `packages/core/src/providers/slack.ts` to support Block Kit `blocks`**: direct fetch is sufficient for this work; provider extension can come when a third Slack-blocks use surfaces.
- **Backfill of artwork for existing posts**: only new `RESOURCE_CREATED` events trigger the loop in v1; backfill via the CLI script is manual until/unless a batch script is needed.
- **The deeper API-integrated flow** ("once we're happy with the model, integrate more deeply"). (origin)

**Deferred from doc-review (P2 / advisory)** — recommendations from the multi-persona review that are worth doing but don't block v1:

- **Sidecar table for `_artwork` state** instead of namespaced field on `post.fields`. The `_artwork` namespace under fields JSON is a pragmatic v1 choice; if it proves leaky (showing up in editor UI, OG metadata, generated TS types), migrate to a `postArtworkState` table keyed by postId.
- **`PostUpdateSchema` shallow-merge guard**: edge case where editor saves a post without including `coverImage` in payload could silently null it via spread+undefined. Audit during U1 implementation; if real, either keep `coverImage` out of `PostUpdateSchema` (write-only via the pipeline) or add a server-side merge guard.
- **Old thread message supersede on Regenerate** is in U7 already as `supersede-prior-batch-message`; if it proves noisy or unreliable, alternative is to leave old messages in place and rely entirely on `batchId` rejection in U9 (which is sufficient functionally; the supersede is a UX nicety).
- **Per-day fal cost cap / budget alarm** — explicit acceptance from origin scope-out.
- **Per-user permission model upgrade** when a second human joins the content channel — log `userId` on cost-incurring steps now (already in plan), revisit when the cliff approaches.
- **`inngest.send` latency telemetry** — add `slack.interactivity.dispatched` timing to detect 3s-budget drift.
- **Slash command rate-limit on rapid double-fire** — Inngest dedup catches it but a 1-second debounce at the route level would prevent the duplicate tracker message.

---

## Context & Research

### Relevant Code and Patterns

- `apps/ai-hero/src/app/api/slack/kit-broadcast-approval/route.ts` — canonical Slack signature-verification + payload-parsing pattern. Mirror for `/api/slack/interactivity` and `/api/slack/commands`. **Do NOT copy its inline-work pattern** — that route does the work inside the 3s ack window; ours must dispatch to Inngest and return 200 immediately.
- `apps/ai-hero/src/inngest/events/resource-management.ts` — `RESOURCE_CREATED_EVENT` already exists. Currently only consumed by `calendar-sync` (filtered to `type === 'event'`). **Posts do NOT emit it today** — adding emission is U1.
- `apps/ai-hero/src/inngest/functions/calendar-sync.ts` (lines 111–119, 346) — exact pattern for `RESOURCE_CREATED` filtered triggers (`if: "event.data.type == 'post'"`) and for calling `courseBuilderAdapter.updateContentResourceFields` directly inside a `step.run`.
- `apps/ai-hero/src/inngest/functions/cloudinary/image-resource-created.ts`, `apps/ai-hero/src/inngest/functions/post-purchase-workflow.ts` — canonical Inngest function shape (`createFunction({ id, name, idempotency }, trigger, handler)`).
- `apps/ai-hero/src/inngest/functions/notify/creator/user-signup.ts` — idempotency-by-event-data pattern.
- `apps/ai-hero/src/inngest/inngest.server.ts` (Events map, lines 127–162) and `apps/ai-hero/src/inngest/inngest.config.ts` (function registry) — three-place registration required for every new event/function pair.
- `apps/ai-hero/src/inngest/inngest-telemetry-middleware.ts` — auto-logs lifecycle. Domain-specific Axiom logs only.
- `apps/ai-hero/src/utils/cloudinary.ts` and `apps/ai-hero/src/trpc/api/routers/certificate.ts` (server-side `cloudinary.uploader.upload` example) — reuse the wrapper; results yield `secure_url` + `public_id`.
- `apps/ai-hero/src/lib/posts.ts` — `PostSchema` and `PostUpdateSchema`. Add `coverImage` here. Currently no cover/og field.
- `apps/ai-hero/src/lib/workshops.ts` (lines 22–27), `apps/ai-hero/src/lib/module.ts` (line 35) — `coverImage: { url, alt? }` shape to mirror. (Cohort uses flat `image: string` — do NOT mirror.)
- `apps/ai-hero/src/lib/posts/posts.service.ts` — `createPost` (line 143). U1 adds the `inngest.send(RESOURCE_CREATED_EVENT)` call after the DB write.
- `apps/ai-hero/src/lib/posts-query.ts` (`writePostUpdateToDatabase`, lines 821–937) — atomic whole-fields-blob replace. The pipeline bypasses `updatePost` entirely; calls `courseBuilderAdapter.updateContentResourceFields` directly inside the Inngest step.
- `apps/ai-hero/src/app/md/[slug]/route.ts` and `apps/ai-hero/src/lib/markdown-serializer.ts` (`serializeToMarkdown`) — canonical post-to-markdown serializer. The prompt-translation step calls this server-side, not `post.fields.body` raw.
- `apps/ai-hero/src/app/api/chat/route.ts`, `apps/ai-hero/src/app/api/analytics/chat/route.ts`, `packages/core/src/inngest/util/streaming-chat-prompt-executor.ts` — codebase convention: all LLM calls go through the AI SDK gateway (`@ai-sdk/gateway`). No direct `@anthropic-ai/sdk` usage. The new prompt-translation step follows this.
- `apps/ai-hero/src/coursebuilder/slack-provider.ts` and `packages/core/src/providers/slack.ts` — `notificationProvider.sendNotification` works for outbound text/attachments, but does NOT expose Block Kit `blocks`. The notify/generate/pick functions call `chat.postMessage` via direct fetch (URL: `https://slack.com/api/chat.postMessage`, `Authorization: Bearer ${env.SLACK_CONTENT_BOT_TOKEN}`).
- `apps/ai-hero/src/env.mjs` — three-section pattern (`server`, `client`, `runtimeEnv`). `SLACK_SIGNING_SECRET`, `SLACK_TOKEN`, `SLACK_DEFAULT_CHANNEL_ID`, `ANTHROPIC_API_KEY` already declared. New: `FAL_API_KEY`, `FAL_LORA_URL`, `SLACK_CONTENT_CHANNEL_ID`.
- `apps/ai-hero/src/test/setup.ts` — vitest mocks `@/env.mjs` with hard-coded values; extend with the new keys or new-env-using modules will fail to load under test.
- `apps/ai-hero/src/server/logger.ts` — Axiom logger. Conventions: dotted event names (`post.artwork.notify`, `slack.interactivity.invalid_signature`), object payloads with high-cardinality IDs, `void log.x()` for fire-and-forget.

### Institutional Learnings

- No `docs/solutions/` directory exists in this monorepo. Closest analogs are `docs/adrs/` and `apps/ai-hero/docs/flows/`. After this lands, write an ADR (artwork pipeline) and a flow doc under `apps/ai-hero/docs/flows/` so the next person can find this pattern.
- ADR-0001 (`docs/adrs/ADR-0001-content-resource-api-surface.md`) governs how `contentResource.fields` may be extended. New fields must be camelCase, optional unless required, and added via the standard zod-schema extension path.
- Inngest patterns from existing functions: set `idempotency: 'event.data.<stableId>'` on the function config; throw `NonRetriableError` for permanent failures (post not found, billing 4xx) so the default 4× retry doesn't burn fal credits on terminal errors.

### External References

- fal.ai Node SDK (2026): `@fal-ai/client` v1.x is canonical. `@fal-ai/serverless-client` is deprecated. https://docs.fal.ai/model-apis/client
- fal queue API + webhooks: https://docs.fal.ai/model-apis/model-endpoints/queue — required pattern for serverless (subscribe blocks the lambda).
- fal flux-lora model API: https://fal.ai/models/fal-ai/flux-lora/api — input shape, supported sizes, response shape.
- fal output URL durability: persistent on `fal.media` CDN but treat as ephemeral; download and re-host to Cloudinary. https://docs.fal.ai/model-apis/faq
- Slack signature verification in App Router: https://docs.slack.dev/authentication/verifying-requests-from-slack — raw body MUST be read once via `await req.text()` before any parser.
- Slack 3-second ack rule: https://docs.slack.dev/interactivity/handling-user-interaction
- Slack Block Kit reference: https://docs.slack.dev/reference/block-kit/block-elements (`image`, `actions`, `button` blocks; `value` capped at 2000 chars; button text capped at 75 chars).
- Slack `message.metadata.event_payload` is the right place for correlation IDs (round-trips via `payload.message.metadata` on button clicks): https://docs.slack.dev/reference/methods/chat.postMessage
- Slack block_actions payload shape: https://docs.slack.dev/reference/interaction-payloads/block_actions-payload
- Slack `image` block reference: https://docs.slack.dev/reference/block-kit/blocks#image — full-width image rendering in messages.
- Cloudinary upload from URL: https://cloudinary.com/documentation/upload_images#remote_image_url — `cloudinary.uploader.upload(remoteUrl)` accepts a remote URL directly; no client-side download needed.
- Inngest dedup via event `id` field (24h window): https://www.inngest.com/docs/events
- Inngest `step.waitForEvent` pattern: https://www.inngest.com/docs/reference/functions/step-wait-for-event

---

## Key Technical Decisions

- **Slack interactivity is verify → `inngest.send` → 200**, never inline work. The existing `kit-broadcast-approval` route is the verification reference but its inline-work pattern is the wrong shape for fal's 30-60s latency. Rationale: Slack's 3s ack window cannot accommodate fal generation; missing the window invokes Slack retries which compound the cost problem.
- **Use `@fal-ai/client` v1.x with `queue.submit` + webhook**, not `subscribe()`. Rationale: `subscribe()` blocks the lambda for the full generation duration, costing serverless compute and risking the 300s Vercel timeout. The webhook pattern returns the lambda immediately and resumes via a separate HTTP endpoint that fires an Inngest `artwork/fal.completed` event into a `step.waitForEvent` in the generation workflow.
- **Route all LLM calls through `@ai-sdk/gateway`**, not `@anthropic-ai/sdk` directly. Rationale: codebase convention — every existing LLM call uses AI SDK; introducing a direct Anthropic dep would be the only such instance and forks the observability/provider-switching path. Use `generateText` with a Claude model from the gateway.
- **`coverImage: { url, alt? }` on `post.fields`**, mirroring workshop/module convention (not cohort's flat `image: string`). Rationale: structured shape supports future alt-text accessibility and metadata without a schema change; matches the dominant pattern in the codebase.
- **Bypass `posts.service.updatePost`; call `courseBuilderAdapter.updateContentResourceFields` directly inside the pick Inngest step.** Rationale: `updatePost` re-runs slug/video/duration/yDoc logic that's irrelevant for a cover-image write and would re-validate the entire `PostUpdateSchema`. Direct adapter call is the precedent in `calendar-sync.ts:346`.
- **Direct `fetch` to Slack's Web API** for Block Kit messages instead of extending `notificationProvider.sendNotification`. Rationale: the core provider only accepts legacy `attachments`; extending it for a single new use is more surface than benefit. When a third Slack-blocks use surfaces, extract.
- **`batchId` correlation**: each generation creates a `batchId` stored on the post (`post.fields.currentArtworkBatchId`); the batchId is also embedded in `message.metadata` of the variant thread reply. Pick handler reads both and rejects mismatches as stale-batch. Rationale: without correlation, clicking Pick on a pre-Regenerate variant message silently sets the wrong cover.
- **In-flight protection**: writing `post.fields.artworkGenerationStartedAt` before the fal call short-circuits rapid double-clicks of Generate. Manual replay (CLI/slash command) bypasses this guard. Rationale: a misclick should not cost 4× fal credits; intentional re-runs (replay triggers) explicitly opt out.
- **Terminal-state UI via `chat.update`**: original notification message is updated in place — Generate becomes "Generating…" disabled, then "Picked variant N" or "Skipped". Rationale: live-button stale messages accumulate as misleading UI; updating in place keeps the channel scannable.
- **No image post-processing in v1.** The pipeline does not run `sharp`, does not composite foreground assets, does not crop. Raw fal output is shown in Slack and uploaded to Cloudinary as-is on Pick. Rationale: the user wants to iterate on the LoRA itself first; visual branding/composition is a separate concern that belongs in a dynamic OG route layer (next to the existing OG infra at `src/app/api/og/`), not inside the artwork generation step. Removes a native binary, a foreground asset, and 1200×630/density-heuristic decisions from the surface area.
- **Upload to Cloudinary only on Pick (1× upload), not at variant time (4× upload).** Slack displays the variants directly from fal's CDN. The picked variant's fal URL is uploaded to Cloudinary by the Pick handler, which then writes the Cloudinary `secure_url` to `post.fields.coverImage`. Rationale: with no post-processing, there's no reason to pay 4× the Cloudinary upload cost up front — fal URLs render fine in Slack (they're persistent on `fal.media`) and only one variant ever becomes the cover. If a Pick fires after fal has GC'd the URL (rare), the Pick fails cleanly with a Retry that re-runs generation.
- **Slack uses full-width `image` blocks for previews**, not section-with-accessory. Rationale: the user explicitly wants nice image previews; full-width image blocks render the variant at a much larger size than the small thumbnail an accessory produces.
- **Idempotency layered**:
  1. Inngest event `id` namespaced per action (e.g., `slack-pick:<message_ts>:<variant_idx>`) for 24h dedup;
  2. Slack signing-secret 5-min replay window blocks Slack retries upstream;
  3. Deterministic Cloudinary `public_id` on Pick (`post_<id>_<batchId>_v<idx>`) so Pick retries overwrite rather than orphan blobs.
- **`SLACK_CONTENT_CHANNEL_ID` is its own env var**, not a reuse of `SLACK_DEFAULT_CHANNEL_ID`. Rationale: avoids polluting whatever default channel does today (commerce/ops), keeps the artwork backlog separable.
- **Prompt translation feeds `serializeToMarkdown(post)`**, not `post.fields.body` raw. Rationale: the canonical AI-friendly serialization is already used by `/md/[slug]`; using it here keeps prompt-input consistent and avoids feeding raw yDoc/MDX to the LLM.
- **CLI replay script + `/artwork` slash command both fire the same Inngest event** the post-create path emits, with a `bypassGuards: true` flag in the event payload. Rationale: one execution path, two trigger surfaces; the bypass flag keeps the in-flight + cover-set guards honored on real post creates.

---

## Open Questions

### Resolved During Planning

- **What field name on the post stores the cover image?** → `post.fields.coverImage: { url, alt? }`. Mirrors workshops/modules; cohort flat-string convention is the outlier.
- **Where does the LoRA URL config live?** → Env var `FAL_LORA_URL` for v1. DB-backed config deferred until multiple active LoRAs.
- **Sharp vs Cloudinary transformations for compositing?** → Neither in v1. No compositing; raw fal output is the artwork. When we want branded OG, build it as a dynamic OG route on top of the picked Cloudinary URL.
- **Auto-retry vs manual try-again on failure?** → Inngest default 4× retries on transient errors (Cloudinary 5xx, Slack 5xx); `NonRetriableError` for terminal (fal billing 4xx, post deleted). Manual try-again button on failures fal/Cloudinary surface in the thread.
- **Slack interactivity work pattern (inline vs dispatch)?** → Always dispatch to Inngest. The existing kit-broadcast-approval route does work inline; we deliberately diverge because of fal latency.
- **Cover-already-set warning timing (notification vs click time)?** → Read at click time, since the post can change between notification and click.
- **LLM input source (raw body vs serialized markdown)?** → `serializeToMarkdown(post)` server-side — same as the `/md/[slug]` route.

### Deferred to Implementation

- **Exact AI SDK gateway model identifier and prompt template for hook extraction**: depends on what the gateway exposes today; pick during U7 implementation. Test with two or three real posts to tune the system prompt before locking it.
- **fal webhook signature verification**: confirm fal's webhook signing scheme during U8; treat as security-sensitive (a forged webhook can short-circuit `step.waitForEvent`).
- **Vercel function `maxDuration` for the generate-artwork Inngest function**: tune during U7 — fal can take 30-60s, but with the queue-webhook pattern the function only orchestrates (the wait-for-event step is durable, not in-process) and shouldn't need >60s.
- **Whether the Slack provider extension to support `blocks`** is worth doing during this work or later: defer to U5/U6 implementation; if direct fetch feels wrong on the third use, extract then.
- **How to handle `getPost(slug)` resolution** in the slash command when slug collides with an unrelated content type: probably restrict to `type === 'post'` lookup, but confirm against `getCachedPostOrList` behavior during U11.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
                   ┌─────────────────┐
   Matt's          │ POST /api/posts │
   API call    ───▶│  createPost      │
                   └────────┬────────┘
                            │ U1: emit RESOURCE_CREATED
                            ▼
                   ┌─────────────────┐
                   │ Inngest event:  │
                   │ resource/created│
                   └────────┬────────┘
                            │ U5: notify-on-post-created
                            ▼
                   ┌─────────────────┐         ┌──────────────────┐
                   │  Slack channel  │         │ CLI: scripts/    │  U10
                   │ "post-artwork"  │◀────────│  artwork-replay  │
                   │  [Gen][Skip]    │         └──────────────────┘
                   └────┬───┬────────┘                   │
                        │   │                            │
            click Gen   │   │ click Skip                 │
                        │   ▼                            │
                        │  U9: skip → chat.update        │
                        ▼                                │
              ┌──────────────────┐  ◀───────────────────┘
              │  POST /api/slack/│  ◀── U11: /artwork slash command
              │  interactivity   │      (POST /api/slack/commands)
              │  verify→send→200 │
              └────────┬─────────┘
                       │ U4 events: slack/artwork.{generate,regenerate,pick,skip}.requested
                       ▼
              ┌──────────────────────────┐
              │ U7: generate-artwork     │
              │  step: check post        │
              │  step: mark generating   │
              │  step: chat.update       │  ── "Generating…"
              │  step: serializeToMarkdown
              │  step: AI SDK gateway →  │  ── hook descriptor
              │        fal.queue.submit  │  ── webhookUrl
              │  step.waitForEvent ────────────┐
              │   "artwork/fal.completed"      │
              │  step: refetch fal status │   │
              │  step: validate hostnames │   │
              │  step: chat.postMessage   │   │
              │   thread reply: 4 image   │   │
              │   blocks (fal URLs) +     │   │
              │   Pick × 4 + [🔄]         │   │
              └──────────────────────────┘   │
                                             │
                       ┌─────────────────────┘
                       │
              ┌────────▼─────────┐
              │ U8: POST /api/   │   ◀── fal webhook
              │  fal/webhook     │
              │  signal-only:    │
              │  emit artwork/   │
              │  fal.completed   │
              └──────────────────┘

              ┌──────────────────────────┐
              │ U9: pick-variant         │
              │  step: verify batch      │
              │   (batchId match?)       │
              │  step: cloudinary upload │  ── from picked fal URL
              │  step: writeContentRes   │
              │   Fields(coverImage)     │
              │  step: chat.update       │  ── "Picked variant N"
              └──────────────────────────┘
```

---

## Implementation Units

- U1. **Add `coverImage` field, namespaced pipeline state, and emit `RESOURCE_CREATED` on post create from BOTH paths**

**Goal:** Add the user-visible `coverImage` field, keep pipeline-private state OFF the public schema by namespacing it under `fields._artwork`, and ensure `RESOURCE_CREATED` fires for posts created via EITHER the API service path OR the admin UI path (which use different `createPost` functions today).

**Requirements:** R10, R1 (depends on the event firing)

**Dependencies:** None (U1 is the foundation)

**Files:**
- Modify: `src/lib/posts.ts` — add to `PostSchema.fields`:
  - `coverImage: z.object({ url: z.string().url(), alt: z.string().optional() }).optional()` (user-visible, written by Pick).
  - `_artwork: z.object({ batchId: z.string().optional(), startedAt: z.string().datetime().optional() }).optional()` (pipeline-private state, leading-underscore namespace signals "do not depend on this externally").
  - Add `coverImage` (only) to `PostUpdateSchema.fields` so Matt's API can later set the cover. Do NOT add `_artwork` to `PostUpdateSchema` — pipeline state must not be settable via the public update path.
- Modify: `src/lib/posts/posts.service.ts` — after `writeNewPostToDatabase` returns inside `createPost`, fire `RESOURCE_CREATED` (idempotency id `post-created:<post.id>`).
- Modify: `src/lib/posts-query.ts` — the UI path's `createPost` (around line 196, called by `src/app/(content)/posts/_components/create-post.tsx`) ALSO fires `RESOURCE_CREATED` with the same idempotency id. Two emission sites, one Inngest event id → idempotent against any double-fire and converging on a single notification regardless of which create path the post took.
- Test: `src/lib/posts/posts.service.test.ts` (new if absent), `src/lib/__tests__/posts-query-create-post.test.ts` (new for the UI path).

**Approach:**
- Field addition is additive and optional → no migration. ContentResource stores `fields` as JSON; new optional fields are forward-compatible.
- The leading-underscore `_artwork` convention signals to readers and any future schema generators that the field is internal. The plan does NOT extract this into a separate `postArtworkState` table for v1 — that's a heavier change with cross-cutting impact on the contentResource model and is deferred. If the namespace approach proves leaky in practice (e.g., `_artwork` ends up in OG metadata, leaks into editor UI), revisit with a sidecar table.
- Two emission sites are explicitly intentional. They both pass the same Inngest event `id`, which Inngest dedupes for 24h — so even if the same post somehow triggers both code paths (it shouldn't, but defense in depth), only one notification fires.
- `_artwork.batchId` lives both on the post (for stale-Pick rejection in U9) and in the Slack thread message metadata (for round-tripping through Pick clicks). Single source of truth at click-time = the post's value; the Slack metadata is just what the click payload carries.

**Patterns to follow:**
- `src/lib/workshops.ts` lines 22–27 — `coverImage: { url, alt }` shape.
- `src/lib/image-resource-query.ts:52–58` — `inngest.send` from a service file.
- `src/inngest/events/resource-management.ts` — event payload shape.

**Test scenarios:**
- Covers AE1 (entry path A, API). Happy path: `posts.service.createPost({ type: 'post', ... })` returns the post AND fires one `RESOURCE_CREATED` event with `data: { id, type: 'post' }` and `id: 'post-created:<id>'`. Assert via mocked `inngest.send`.
- Covers AE1 (entry path B, UI). Happy path: `posts-query.createPost({ ... })` from the UI form fires the SAME shape, with the SAME idempotency id.
- Edge case: both paths fire for the same post id (defense-in-depth scenario) → Inngest dedupes via `id`; only one notification appears in the Slack channel.
- Edge case: post creation with non-`post` type fires `RESOURCE_CREATED` with the correct `data.type` (only `data.type === 'post'` is consumed by the artwork pipeline; other types are ignored by the trigger filter).
- Edge case: parsing a Post with both `coverImage` and `_artwork`, with neither, and with only one — all round-trip cleanly through `PostSchema.parse`.
- Edge case: `PostUpdateSchema.parse({ fields: { _artwork: {...} } })` REJECTS (the field is not in the update schema); only `coverImage` is accepted.

**Verification:** Creating a post via both `POST /api/posts` AND the admin UI produces a `resource/created` event visible in the Inngest dev UI, with `data.type === 'post'` and `data.id` matching the returned post id. `pnpm typecheck` shows `_artwork` is not exposed by `PostUpdateSchema`.

---

- U2. **Add env vars and `@fal-ai/client` dependency**

**Goal:** Land config and the single new dependency as one coherent commit. No native binaries, no asset files.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Modify: `src/env.mjs` — add five new server-side keys, all `z.string().optional()` initially with runtime-required guards inside the artwork functions:
  - `FAL_API_KEY` — fal.ai dashboard
  - `FAL_LORA_URL` — contents of `aihero-design/lora-training/.v9_lora_url`
  - `SLACK_CONTENT_CHANNEL_ID` — the new dedicated content channel ID (channel scope is broader than artwork; future content workflows like translation prompts, social posts, etc. can also notify here)
  - `SLACK_CONTENT_BOT_TOKEN` — Bot User OAuth Token for the new dedicated content bot (separate from the existing `SLACK_TOKEN` used by kit-broadcast-approval)
  - `SLACK_CONTENT_BOT_SIGNING_SECRET` — Signing Secret for the new content bot Slack app (separate from any existing `SLACK_SIGNING_SECRET`)
  Add corresponding entries in `runtimeEnv`.
- Modify: `src/test/setup.ts` — extend the env mock with the five new keys AND any existing Slack/AI keys the new code paths reference (`SLACK_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_DEFAULT_CHANNEL_ID`, `ANTHROPIC_API_KEY`).
- Modify: `package.json` — add `@fal-ai/client@^1` (verify current major in registry at install time). **No `sharp` dep** — v1 does no image processing.
- Modify: `.env.example` — add the five new entries (next to the existing Slack vars).

**Approach:**
- Use `getRequiredEnv(env.FAL_API_KEY, 'FAL_API_KEY')` (or equivalent runtime guard pattern from `src/app/api/slack/kit-broadcast-approval/route.ts:60`) inside the Inngest functions that consume these vars, so missing config in dev doesn't break unrelated routes at boot.

**Patterns to follow:**
- `src/env.mjs` existing three-section structure.
- `src/app/api/slack/kit-broadcast-approval/route.ts:60–64` `getRequiredEnv` pattern.

**Test scenarios:**
- Test expectation: none — pure config + dep addition. Manual verification: `pnpm install` succeeds, `pnpm typecheck` passes, `pnpm dev` boots without env validation errors.

**Verification:** `pnpm typecheck` clean; `pnpm test` passes (env mock extended); `pnpm dev` boots.

---

- U3. **Extract Slack signature verification into a shared util**

**Goal:** Turn the inline `verifySlackSignature` from `kit-broadcast-approval/route.ts` into a reusable helper so the new interactivity + slash-command routes share the same verified-and-tested code path.

**Requirements:** R13 (precondition for both new Slack routes)

**Dependencies:** None

**Files:**
- Create: `src/utils/verify-slack-signature.ts` — exports `verifySlackSignature(request: Request, rawBody: string): Promise<boolean>` and `parseSlackPayload(rawBody: string)` for the URL-encoded `payload` field unwrap.
- Modify: `src/app/api/slack/kit-broadcast-approval/route.ts` — replace inline verification with imports from the new util. Behavior must be identical.
- Test: `src/utils/__tests__/verify-slack-signature.test.ts`

**Approach:**
- Lift the timing-safe HMAC-SHA256 + 5-min replay window logic verbatim. No behavior change.
- Keep the helper environment-agnostic — `verifySlackSignature(request, rawBody, signingSecret)` takes the signing secret as a required argument, NOT defaulted from env. This way the kit-broadcast-approval route passes `env.SLACK_SIGNING_SECRET` (its existing bot's secret) and the new artwork routes pass `env.SLACK_CONTENT_BOT_SIGNING_SECRET` (the new dedicated content bot's secret). One helper, two callers, two distinct secrets — purpose-specific bots stay isolated.

**Patterns to follow:**
- `src/app/api/slack/kit-broadcast-approval/route.ts` lines 75–95 — the verification logic to lift.
- `src/app/api/webhooks/ai-coding-dictionary/route.ts:13–40` — adjacent HMAC pattern (different secret).

**Test scenarios:**
- Happy path: a request with valid `X-Slack-Signature` and a recent `X-Slack-Request-Timestamp` returns `true`.
- Edge case: signature with a stale timestamp (>5 min old) returns `false`.
- Edge case: tampered raw body → signature mismatch → `false`.
- Edge case: missing signature header → `false`, no throw.
- Integration: `kit-broadcast-approval` route tests still pass after the inline verification is replaced.

**Verification:** Manual smoke of the existing `kit-broadcast-approval` route confirms it still verifies correctly. New unit tests pass.

---

- U4. **Define new Inngest events for the artwork pipeline**

**Goal:** Declare and register all events the pipeline uses, so subsequent function units have well-typed triggers from day one.

**Requirements:** R4, R12, R13

**Dependencies:** None

**Files:**
- Create: `src/inngest/events/artwork.ts` — seven events:
  - `slack/artwork.generate.requested` — `{ postId, channelId, originalMessageTs, bypassGuards?: boolean }`
  - `slack/artwork.regenerate.requested` — `{ postId, channelId, threadTs, currentArtworkBatchId, bypassGuards?: boolean }` — fires from the **variant thread message only** (where metadata carries the batchId), never from the original notification (which doesn't have a batchId at notify-time).
  - `slack/artwork.pick.requested` — `{ postId, channelId, threadTs, batchId, variantIndex, falUrl, pickedByUserId }` — `falUrl` is the picked variant's fal CDN URL, captured at click-time from the button payload.
  - `slack/artwork.skip.requested` — `{ postId, channelId, originalMessageTs }`
  - `slack/artwork.retry.requested` — `{ postId, channelId, threadTs, batchId, originalMessageTs, retryStage: 'generate' | 'pick', pickedByUserId?, variantIndex?, falUrl? }` — fires when A2 clicks the Retry button on a failure thread reply. Re-fires the original event (generate or pick) with `bypassGuards: true`. `falUrl` is carried for `'pick'` retries.
  - `artwork/fal.completed` — `{ batchId, postId, falRequestId }` — signal-only; URLs are re-fetched in U7, never trusted from this payload.
  - `artwork/generation.failed` — `{ postId, batchId, channelId, threadTs, originalMessageTs, stage: 'llm' | 'fal' | 'cloudinary' | 'pick', errorMessage }`
- Modify: `src/inngest/inngest.server.ts` — register all six in the `Events` map.
- Test: TypeScript compile is the primary check; add a small unit test that round-trips one event payload through a zod schema if one is defined.

**Approach:**
- Mirror the `RESOURCE_CREATED` event-typing pattern from `src/inngest/events/resource-management.ts`. Each event is a `{ name: typeof CONST, data: ... }` type plus a const string.
- Naming convention: `<source>/<entity>.<verb>` (e.g., `slack/artwork.pick.requested`, `artwork/fal.completed`) — matches existing `cloudinary/web-hook-event`, `resource/created`.

**Patterns to follow:**
- `src/inngest/events/resource-management.ts`
- `src/inngest/events/image-resource-created.ts`

**Test scenarios:**
- Test expectation: none — pure type definitions. TypeScript compile catches misuse downstream.

**Verification:** `pnpm typecheck` clean; events appear in Inngest dev UI dropdown after `pnpm dev`.

---

- U5. **Build `notify-on-post-created` Inngest function**

**Goal:** Listen for `RESOURCE_CREATED` (filtered to `type === 'post'`), post a Block Kit notification to the artwork channel with Generate + Skip buttons.

**Requirements:** R1, R2, R3, R11

**Dependencies:** U1, U2, U4

**Files:**
- Create: `src/inngest/functions/artwork/notify-on-post-created.ts`
- Modify: `src/inngest/inngest.config.ts` — register the function.
- Test: `src/inngest/functions/artwork/__tests__/notify-on-post-created.test.ts`

**Approach:**
- Trigger: `{ event: RESOURCE_CREATED_EVENT, if: "event.data.type == 'post'" }` (mirror calendar-sync pattern).
- Idempotency: `event.data.id` (post id).
- `step.run('fetch-post')`: load via `getCachedPostOrList(event.data.id)`. If not found or not type=post, `NonRetriableError`.
- `step.run('post-notification')`: direct `fetch('https://slack.com/api/chat.postMessage', ...)` with:
  - `channel: env.SLACK_CONTENT_CHANNEL_ID`
  - `text` fallback (for Slack search/notifications)
  - `blocks`: a section with title + slug + edit URL + post type, then an `actions` block with two buttons: `[Generate Artwork]` (action_id `artwork.generate`, value JSON `{postId}`) and `[Skip]` (action_id `artwork.skip`, value JSON `{postId}`). The `Regenerate` button does NOT appear here — it lives only on variant thread messages where the metadata carries the batchId.
  - The "⚠️ cover already set — picking will overwrite" warning is NOT included as a static context block at notify-time. Instead, it's checked dynamically in U7 (Generate handler) at click-time, since Matt could set or change the cover between notify and click. If a cover exists at click-time, the bot posts an ephemeral confirmation prompt to A2 in the artwork channel before kicking off generation.
  - `metadata: { event_type: 'artwork_notification', event_payload: { postId } }` — round-trips the post id through the button payload.
- Logs: `void log.info('post.artwork.notify', { postId })`.

**Technical design:**
> *Directional only — actual block shape is for the implementer to assemble against current Block Kit reference.*
```
{
  channel: env.SLACK_CONTENT_CHANNEL_ID,
  text: `New post: ${post.fields.title}`,
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n_${slug}_ · _${postType}_ · <${editUrl}|Edit>` } },
    { type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Generate Artwork' }, style: 'primary', action_id: 'artwork.generate', value: JSON.stringify({ postId }) },
      { type: 'button', text: { type: 'plain_text', text: 'Skip' }, action_id: 'artwork.skip', value: JSON.stringify({ postId }) },
    ]},
  ],
  metadata: { event_type: 'artwork_notification', event_payload: { postId } },
}
```

**Patterns to follow:**
- `src/inngest/functions/calendar-sync.ts` lines 111–119 (filtered RESOURCE_CREATED trigger).
- `src/inngest/functions/cloudinary/image-resource-created.ts` (canonical simple function shape).
- `src/app/api/slack/kit-broadcast-approval/route.ts` block-kit + JSON-stringified value pattern.

**Test scenarios:**
- Covers AE1. Happy path: event fires for a `type === 'post'` resource → fetch succeeds → `chat.postMessage` is called with the expected channel, text, blocks (including `[Generate Artwork]` + `[Skip]` buttons), and metadata containing `postId`.
- Edge case: event fires for `type === 'lesson'` → function never runs (filter excludes). Verify by asserting `chat.postMessage` mock isn't called.
- Edge case: post has `fields.coverImage` set → notification includes the "cover already set" context block.
- Error path: `getCachedPostOrList` returns null → `NonRetriableError` thrown; no Slack call made; Axiom log records the miss.
- Error path: Slack returns a non-200 response → step retries up to Inngest default; final failure logged.

**Verification:** Creating a post in the local dev env produces a notification message in `#post-artwork` with both buttons rendered.

---

- U6. **Build `/api/slack/interactivity` route (verify → dispatch → 200)**

**Goal:** Receive Slack button-click payloads, verify the signature, parse the action, fire the matching Inngest event, return 200 within the 3s window.

**Requirements:** R13, R14

**Dependencies:** U3, U4

**Files:**
- Create: `src/app/api/slack/interactivity/route.ts`
- Test: `src/app/api/slack/interactivity/__tests__/route.test.ts`

**Approach:**
- `runtime = 'nodejs'` (consistent with the wider artwork routes; not strictly required since no native binaries are used).
- Step 1: read raw body via `await request.text()`.
- Step 2: `verifySlackSignature(request, rawBody, env.SLACK_CONTENT_BOT_SIGNING_SECRET)` from U3 → 401 on fail.
- Step 3: `parseSlackPayload(rawBody)` → block_actions JSON.
- Step 4: channel allowlist check against `env.SLACK_CONTENT_CHANNEL_ID` → 403 ephemeral if mismatch.
- Step 5: switch on `payload.actions[0].action_id`. All Inngest event ids are namespaced as `<actionType>:<channel_id>:<message_ts>[:<extra>]` — channel id is included in the namespace because Slack `ts` is workspace-unique by convention but not guaranteed across channels.
  - `artwork.generate` → `inngest.send({ id: \`slack-gen:${payload.channel.id}:${payload.message.ts}\`, name: 'slack/artwork.generate.requested', data: { postId, channelId, originalMessageTs: payload.message.ts } })`
  - `artwork.regenerate` → fires from variant-thread messages only (where `payload.message.metadata.event_payload.batchId` is populated by U7's post-thread-reply step). Reads `currentArtworkBatchId` from that metadata; if absent, returns 200 with an ephemeral "regenerate from a variant message, not the original notification" message.
  - `artwork.pick.<N>` → `slack/artwork.pick.requested` with `variantIndex: N`, `batchId` from `payload.message.metadata.event_payload.batchId`, `falUrl` from `JSON.parse(payload.actions[0].value).falUrl` (with metadata.event_payload.falUrls[N] as fallback), `threadTs: payload.message.ts`. Idempotency id `slack-pick:${payload.channel.id}:${batchId}:${variantIndex}`.
  - `artwork.skip` → `slack/artwork.skip.requested`.
  - `artwork.retry` → `slack/artwork.retry.requested` with the failure context from `payload.message.metadata.event_payload` (carries `retryStage`, `originalMessageTs`, optional `variantIndex`).
- Step 6: return `new Response(null, { status: 200 })`.
- The `inngest.send` await is fine within the 3s budget (~50-150ms typical).
- Logs: `void log.info('slack.interactivity.received', { actionId, postId, userId })`; `void log.warn('slack.interactivity.invalid_signature', {...})`.

**Patterns to follow:**
- `src/app/api/slack/kit-broadcast-approval/route.ts` for verification + payload-parsing — but **not** the inline-work pattern.
- Inngest `id` namespacing: `<actionType>:<message_ts>:<extra>` → 24h dedup.

**Test scenarios:**
- Covers AE2 (entry side). Happy path: a valid signed payload with `action_id: 'artwork.generate'` results in one `inngest.send` call with the right event name, data, and dedup id; route returns 200.
- Happy path: `action_id: 'artwork.pick.2'` → fires `slack/artwork.pick.requested` with `variantIndex: 2`, `batchId` from `payload.message.metadata`, and `falUrl` parsed from `payload.actions[0].value`.
- Edge case: same signed payload posted twice (Slack retry) → second send carries the same `id` → Inngest dedupes; route still returns 200 both times.
- Error path: invalid signature → 401; no Inngest event sent; Axiom warn logged.
- Error path: missing `payload.actions[0]` → 400; no event sent.
- Error path: action_id outside the known set → 200 with ephemeral "unknown action" reply via `response_url`.
- Edge case: payload arrives from a channel that isn't `SLACK_CONTENT_CHANNEL_ID` → 403 ephemeral.

**Verification:** Manually clicking Generate in the notification message produces a `slack/artwork.generate.requested` event in the Inngest dev UI.

---

- U7. **Build `generate-artwork` Inngest function (handles Generate + Regenerate + replay)**

**Goal:** Translate post → hook descriptor via AI SDK, request 4 fal variants via queue+webhook, wait for completion, post variants as a thread reply with full-width image previews and Pick buttons. **No image post-processing, no upfront Cloudinary uploads** — fal URLs are shown directly.

**Requirements:** R4, R5, R6, R7, R12

**Dependencies:** U2, U4, U5, U6

**Files:**
- Create: `src/inngest/functions/artwork/generate-artwork.ts`
- Modify: `src/inngest/inngest.config.ts` — register.
- Test: `src/inngest/functions/artwork/__tests__/generate-artwork.test.ts`

**Approach:**
- Triggers: `slack/artwork.generate.requested` AND `slack/artwork.regenerate.requested` (handler branches on event name).
- **Concurrency limit**: `concurrency: { key: 'event.data.postId', limit: 1 }`. Serializes parallel Generate/Regenerate runs against the same post so `mark-generating` writes land in click-order.
- No function-level idempotency (re-clicks are intentional; idempotency is enforced at the Inngest event-id level in U6).
- Step `check-post`: load post; if missing, fire failure event and bail.
- Step `check-cover-already-set` (R11, dynamic): if `post.fields.coverImage` exists AND `event.data.bypassGuards` is false, `chat.postEphemeral` confirmation ("⚠️ Cover already set — generating new variants will let you overwrite it. [Continue] [Cancel]") and `step.waitForEvent` on the response (timeout 5m → bail). On replay (bypassGuards true), skip.
- Step `check-in-flight` (skipped if `event.data.bypassGuards`): read `post.fields._artwork.startedAt`; if within last 90s, `chat.postEphemeral` "already generating, hang tight" and bail.
- Step `mark-generating`: write `_artwork: { batchId: <new uuid>, startedAt: <iso> }` via `courseBuilderAdapter.updateContentResourceFields` (preserves existing `coverImage` and other fields).
- Step `update-original-to-pending`: `chat.update` swaps the Generate/Skip buttons for a context block "🎨 Generating artwork… (~60s)".
- Step `serialize-post`: call `serializeToMarkdown(post)`.
- Step `extract-hook`: AI SDK gateway `generateText` with a system prompt that says: "You produce ONLY a 5-12 word visual-noun descriptor for an abstract image. No prose, no explanation." Validate non-empty + reasonable length; on garbage/refusal, fall back to `post.fields.title`. Tag the thread message with "(fallback prompt)" if used.
- Step `submit-fal`: `fal.queue.submit('fal-ai/flux-lora', { input: { prompt: composeFinalPrompt(hook), loras: [{ path: env.FAL_LORA_URL, scale: 1.0 }], image_size: 'landscape_16_9', num_inference_steps: 28, num_images: 4, enable_safety_checker: false }, webhookUrl: \`${env.NEXT_PUBLIC_URL}/api/fal/webhook?batchId=${batchId}&postId=${postId}\` })`. Persist `falRequestId` for traceability.
- Step `wait-for-fal`: `step.waitForEvent('await-fal', { event: 'artwork/fal.completed', timeout: '5m', if: 'async.data.batchId == event.data.batchId' })` → null on timeout → failure path.
- Step `refetch-fal-status` (**security-critical, defense-in-depth**): always call `fal.queue.status(falRequestId)` to authoritatively retrieve image URLs from fal directly. Do NOT trust webhook payload URLs — the webhook is signal-only.
- Step `validate-image-urls`: for each URL from the re-fetch, validate hostname against the fal CDN allowlist (`*.fal.media`, `*.fal.ai` — confirm exact pattern against current fal docs at implementation time). On failure → `artwork/generation.failed` with `stage: 'fal'`, `errorMessage: 'untrusted image URL hostname'`.
- Step `post-thread-reply`: direct `fetch` to `chat.postMessage` with `thread_ts: originalMessageTs` and `unfurl_links: false` (we render images explicitly via blocks). Block layout for nice previews:
  - For each variant `i ∈ [0..3]`:
    - One `image` block: `{ type: 'image', image_url: <fal URL>, alt_text: \`${hookDescriptor} — variant ${i + 1}\`, title: { type: 'plain_text', text: \`Variant ${i + 1}\` } }` — full-width preview, much larger than a section accessory.
    - One `actions` block immediately after with a single Pick button: `[Pick variant ${i+1}]` (action_id `artwork.pick.${i}`, value `JSON.stringify({ falUrl })`, max 2000 chars — a fal URL is ~150 chars).
  - One trailing `actions` block with `[🔄 Regenerate]` only (action_id `artwork.regenerate`).
  - `metadata: { event_type: 'artwork_variants', event_payload: { postId, batchId, hookDescriptor, originalMessageTs, falUrls: [...] } }` — fal URLs round-trip through metadata so Pick can fall back to metadata if the button value is missing for any reason.
- Step `supersede-prior-batch-message` (regenerate path only): `chat.update` the prior batch's variant message to "🔁 Superseded by newer batch" and remove Pick buttons.
- Each step wrapped in try/catch. **Terminal failures** (post deleted, fal billing 4xx, hostname validation fail, AI SDK refusal) emit `artwork/generation.failed` AND `chat.postMessage` a fresh failure message with a Retry button (action_id `artwork.retry`, metadata carrying `retryStage: 'generate'`) AND `chat.update` the original notification to "❌ Generation failed — [Retry]". **Transient failures** re-throw to Inngest retry (default 4×).

**Why image blocks instead of section-with-accessory:** Slack's `image` block renders the variant at a generous size that scales nicely on desktop and mobile. Section accessories cap the image at ~88×88 (thumbnail size), which makes it hard to actually evaluate a variant. The trade-off is one extra block per variant (image + actions vs single section), but the visual quality is the whole point of this loop.

**Execution note:** Wrap each external call (AI SDK, fal submit, slack) in its own `step.run` so retries are surgical. Throw `NonRetriableError` from the AI SDK call when validation fails terminally.

**Patterns to follow:**
- `src/app/api/chat/route.ts` and `packages/core/src/inngest/util/streaming-chat-prompt-executor.ts` — AI SDK gateway usage (use `generateText` for this short call, not streaming).
- `aihero-design/lora-training/og_articles_v9.py` lines 60–95 — port only the **prompt template** (visual-noun phrasing, LoRA invocation). Ignore the sharp/composite parameters; they're not used in v1.

**Test scenarios:**
- Covers AE2. Happy path: `slack/artwork.generate.requested` → all steps run → mocked AI SDK returns hook → mocked `fal.queue.submit` returns request_id → mocked `artwork/fal.completed` unblocks wait → mocked `fal.queue.status` returns 4 fal URLs → hostname validation passes → mocked Slack receives one `chat.postMessage` with 4 `image` blocks (each followed by a single-Pick `actions` block) + trailing Regenerate `actions` block, alt_text populated, metadata carries `falUrls`.
- Happy path: `slack/artwork.regenerate.requested` — prior `_artwork.batchId` replaced AND prior thread message `chat.update`-ed to "Superseded".
- Happy path: replay event with `bypassGuards: true` → cover-already-set + in-flight checks skipped.
- Happy path: cover already set on real click → ephemeral confirmation fires; Continue → proceed.
- Edge case: cover already set + Cancel → flow bails cleanly; no fal call; original notification reverts.
- Edge case: parallel generate + regenerate within 100ms → concurrency limit serializes; second click's batch wins.
- Edge case: AI SDK returns empty → hook falls back to `post.fields.title`; thread message includes "(fallback prompt)".
- **Error (security-critical)**: `fal.queue.status` returns URLs failing the hostname allowlist → `artwork/generation.failed` with `stage: 'fal'`; no Slack image blocks rendered; failure thread reply posted; original updated to "❌ Generation failed".
- Error (terminal): `getCachedPostOrList` null → failure event fired; failure thread reply via `chat.postMessage`.
- Error (terminal): fal billing 4xx → `NonRetriableError`; failure event; original updated to "❌".
- Error: `step.waitForEvent` null after 5min → `artwork/generation.failed` with `stage: 'fal'`; failure message with Retry button.
- Edge case: in-flight guard on a real click (not bypass) → ephemeral "already generating"; no fal call.
- Edge case: fal returns 3 images instead of 4 → render 3 image+actions pairs; trailing Regenerate still rendered.

**Verification:** Clicking Generate in `#post-artwork` produces, within ~60s, a thread reply with 4 large image previews and Pick/Regenerate buttons.

---

- U8. **Build `/api/fal/webhook` route (relay to Inngest — signal only, NOT trusted source of URLs)**

**Goal:** Receive fal's job-completion callback purely as a "wake up the wait-for-event" signal. The webhook payload's URLs are NOT trusted — U7's `refetch-fal-status` step is the authoritative URL source. This route's job is to fire `artwork/fal.completed` to unblock `step.waitForEvent` in U7; nothing more.

**Requirements:** R12

**Dependencies:** U4, U7

**Files:**
- Create: `src/app/api/fal/webhook/route.ts`
- Test: `src/app/api/fal/webhook/__tests__/route.test.ts`

**Approach:**
- `runtime = 'nodejs'`.
- Read raw body. Implement fal's documented webhook signature scheme if available — verify in implementation against current fal docs at U8 time. **However, U7's defense-in-depth pattern (always re-fetch URLs from `fal.queue.status` and validate hostnames against the fal CDN allowlist) means a forged or unsigned webhook can at worst cause a no-op generation cycle (re-fetch returns the wrong job's status, hostname check fails, generation fails cleanly), not a malicious URL injection.** Signature verification is therefore important for cleanliness but not the sole gate.
- Parse fal payload only to extract `request_id` (and optionally a "succeeded/failed" status flag for early-fail signaling). Do NOT propagate `imageUrls` from the payload to the Inngest event.
- Resolve `batchId`/`postId` from query string we passed in `webhookUrl` at submit time (U7).
- Fire `inngest.send({ id: \`fal-completed:${falRequestId}\`, name: 'artwork/fal.completed', data: { batchId, postId, falRequestId } })` — note `imageUrls` is intentionally NOT in the event payload; U7 fetches them from fal directly. The `id` field gives 24h dedup against fal retries.
- Return 200.

**Patterns to follow:**
- `src/app/api/webhooks/ai-coding-dictionary/route.ts` — HMAC webhook precedent.
- The verify-then-200-then-Inngest flow from U6.

**Test scenarios:**
- Happy path: signed fal payload → event sent with `{ batchId, postId, falRequestId }` (no imageUrls) → 200.
- Edge case: duplicate fal callback (fal retry) → second send is deduped via `id`; route still returns 200.
- **Security path: forged unsigned payload with arbitrary imageUrls** → if signature verification rejects, route returns 401 and no event fires. If signature verification is permissive (e.g., scheme not yet implemented), route fires `artwork/fal.completed` with no imageUrls; U7's `refetch-fal-status` step calls fal directly with the (real) `falRequestId` and gets authoritative URLs. The forged payload's URLs never reach Slack image previews or Cloudinary.
- Error path: missing `batchId` query param → 400.
- Error path: malformed payload (no falRequestId) → 400.

**Verification:** End-to-end test through U7 confirms the wait-for-event pattern unblocks correctly. Manual test: post a fake unsigned payload to the webhook with a real `batchId` for an in-flight generation; confirm U7 still produces correct variants from real fal output (defense-in-depth proof).

---

- U9. **Build `pick-variant` Inngest function**

**Goal:** Validate the picked batch is current, upload the picked fal URL to Cloudinary (the only Cloudinary upload in the pipeline), write the Cloudinary URL to `post.fields.coverImage`, update the variant message in place.

**Requirements:** R9, R10, R11

**Dependencies:** U4, U6, U7

**Files:**
- Create: `src/inngest/functions/artwork/pick-variant.ts`
- Modify: `src/inngest/inngest.config.ts` — register.
- Test: `src/inngest/functions/artwork/__tests__/pick-variant.test.ts`

**Approach:**
- Trigger: `slack/artwork.pick.requested`.
- **Concurrency limit**: `concurrency: { key: 'event.data.postId', limit: 1 }` — serializes parallel Pick clicks against the same post so the cover write is deterministic, not last-DB-write-wins.
- Idempotency: Inngest event id from U6 (`slack-pick:<channel_id>:<batchId>:<variant_idx>`) handles dedup.
- Step `verify-batch`: load post, check `post.fields._artwork.batchId === event.data.batchId` → if mismatch, `chat.postEphemeral` "this variant batch was superseded — pick from the latest batch" and bail.
- Step `upload-to-cloudinary`: `cloudinary.uploader.upload(event.data.falUrl, { public_id: \`post_${postId}_${batchId}_v${variantIndex}\`, overwrite: true, folder: 'post-artwork' })`. Cloudinary fetches the fal URL server-side; no need to download into a Buffer first. Capture `secure_url`. **This is the only image upload in the entire pipeline.**
- Step `write-cover`: `courseBuilderAdapter.updateContentResourceFields({ id: postId, fields: { ...post.fields, coverImage: { url: secureUrl, alt: post.fields.title } } })`.
- Step `update-thread-message`: `chat.update` on the variant message → replace all Pick + Regenerate buttons with a context block "✅ Picked variant N by <user> · <cloudinary url>".
- Step `update-original`: `chat.update` on the original notification → "✅ Cover set — variant N picked by <user>" terminal state.
- Logs: `void log.info('post.artwork.variant.picked', { postId, batchId, variantIndex, coverUrl, pickedByUserId })`.

**On terminal failure** (Cloudinary 4xx, post deleted, fal URL no longer reachable): emit `artwork/generation.failed` with `stage: 'pick'` (or `'cloudinary'` if the upload itself failed terminally), post a fresh `chat.postMessage` thread reply with a Retry button (action_id `artwork.retry`, metadata `{ retryStage: 'pick', postId, batchId, variantIndex, falUrl, originalMessageTs }`). Update the original notification to "❌ Pick failed — [Retry]".

**Patterns to follow:**
- `src/inngest/functions/calendar-sync.ts:346` — direct `courseBuilderAdapter.updateContentResourceFields` call inside a step.
- `src/trpc/api/routers/certificate.ts:81–109` — `cloudinary.uploader.upload` server-side pattern (note: `upload(url, ...)` accepts a remote URL directly).

**Test scenarios:**
- Covers AE3. Happy path: pick on current batch → fal URL uploaded to Cloudinary → cover written → variant message updated → original updated.
- Covers AE4. Happy path: post already had a coverImage set manually → pick still overwrites.
- Covers AE6. Happy path: `pickedByUserId` is any user in the channel; pick succeeds (no per-user permission check).
- Edge case: parallel picks within 100ms → concurrency-1 serializes; second click wins deterministically.
- Edge case: stale batch (batchId mismatch) → no upload, no DB write, ephemeral reply only.
- Edge case: pick on a thread message that is days/weeks old → ephemeral feedback works regardless of message age; the fal URL may have been GC'd at that point — the Cloudinary upload fails, retry path kicks in.
- Error path: post deleted between Pick and step run → `NonRetriableError`; ephemeral "post no longer exists"; original updated to "Post deleted".
- Error path: Cloudinary 5xx → step retries; on terminal, `artwork/generation.failed` with `stage: 'cloudinary'` and Retry button.
- Error path: fal URL returns 404 (rare — fal GC'd it) → terminal; failure message says "fal image expired — Regenerate to pick again".

**Verification:** End-to-end: click Pick → Cloudinary URL appears on `post.fields.coverImage`; visiting the post renders the picked variant as the cover.

---

- U10. **Build `skip` Inngest function**

**Goal:** When Skip is clicked, mark the original notification as "Skipped" so the channel reaches a terminal state without generating anything.

**Requirements:** R3

**Dependencies:** U4, U6

**Files:**
- Create: `src/inngest/functions/artwork/skip-notification.ts`
- Modify: `src/inngest/inngest.config.ts` — register.
- Test: `src/inngest/functions/artwork/__tests__/skip-notification.test.ts`

**Approach:**
- Trigger: `slack/artwork.skip.requested`.
- One step: `chat.update` on the original message → replace buttons with "⏭ Skipped by <user>" context block.

**Test scenarios:**
- Happy path: skip event fires → `chat.update` called once with the expected new blocks → original message buttons gone.
- Edge case: original message no longer exists (deleted in Slack) → Slack returns `message_not_found` → log warning, succeed silently.

**Verification:** Manual click of Skip removes buttons from the notification.

---

- U11. **Build `/api/slack/commands` route + `/artwork` slash command handler**

**Goal:** Slash command `/artwork <post-url-or-slug>` fires the same generate event as the button, against any existing post.

**Requirements:** R16, R17

**Dependencies:** U3, U4, U7

**Files:**
- Create: `src/app/api/slack/commands/route.ts`
- Modify: `src/utils/parse-post-slug.ts` (new) — extracts slug from a URL or returns the input as a bare slug.
- Test: `src/app/api/slack/commands/__tests__/route.test.ts`
- Test: `src/utils/__tests__/parse-post-slug.test.ts`

**Approach:**
- `runtime = 'nodejs'`.
- Same verify → respond → dispatch shape as U6, using `verifySlackSignature(request, rawBody, env.SLACK_CONTENT_BOT_SIGNING_SECRET)`.
- Slack POSTs `application/x-www-form-urlencoded` with fields `command, text, user_id, channel_id, response_url, trigger_id`. Read raw body, verify with U3's helper, parse with `URLSearchParams`.
- **Channel restriction (security)**: enforce that `payload.channel_id === env.SLACK_CONTENT_CHANNEL_ID`. If issued from any other channel (DM, unrelated channel, contractor's support channel), return 200 with `{ response_type: 'ephemeral', text: 'Use /artwork in <#${SLACK_CONTENT_CHANNEL_ID}>.' }` and fire NO Inngest event. This collapses the "any workspace member can burn fal credits" attack surface to "anyone with content-channel membership" — same access model as the buttons.
- `text` is the user's input. Extract slug via `parsePostSlug(text)`:
  - Accepts `https://www.aihero.dev/build-first-agent`, `https://www.aihero.dev/md/build-first-agent`, or `build-first-agent`.
  - Strip trailing `.md`, leading slashes, host.
- Resolve `getCachedPostOrList(slug)`. If null or `result.type !== 'post'`, return 200 with `{ response_type: 'ephemeral', text: 'Post not found: <slug>' }`. (The explicit type check matters because `getCachedPostOrList` also resolves lists.)
- Resolve `originalMessageTs`: post a tracker message in `SLACK_CONTENT_CHANNEL_ID` first with the SAME block shape as U5's notification (title, slug, post type, edit link, but with the Generate button already in the "Generating…" disabled state since we're firing immediately) so that U7's `update-original-to-pending` step has a uniform target shape regardless of whether the originalMessageTs came from a real post-create notify or a replay tracker. Capture the tracker's `ts`.
- Fire `slack/artwork.generate.requested` with `id: \`slash-gen:<channel_id>:<tracker_ts>\``, `bypassGuards: true`. The `id` namespace prevents double-fire from rapid command repeat (Slack debounces some, this catches the rest).
- Respond ephemerally to the issuing channel: `{ response_type: 'ephemeral', text: 'Generating artwork for <slug> — variants will land as a thread reply in this channel.' }`.

**Patterns to follow:**
- `src/app/api/slack/interactivity/route.ts` (U6) for the verify → 200 → dispatch shape.

**Test scenarios:**
- Happy path: `/artwork build-first-agent` from inside the content channel → post resolved → tracker message posted with notification-shape blocks (Generating disabled state) → generate event fired with `bypassGuards: true` → ephemeral confirmation returned.
- Happy path: `/artwork https://www.aihero.dev/build-first-agent` → URL parsed to slug; same flow.
- Happy path: `/artwork https://www.aihero.dev/md/build-first-agent` → `.md` URL parsed to slug; same flow.
- **Security path: `/artwork build-first-agent` from a DIFFERENT channel** (DM, unrelated team channel) → returns 200 with ephemeral "Use /artwork in #content"; NO Inngest event fired; NO tracker message posted; NO fal credits at risk.
- Edge case: `/artwork unknown-slug` → ephemeral "Post not found"; no event fired.
- Edge case: `/artwork list-slug` (matches a list, not a post) → ephemeral "Post not found" (type filter rejects).
- Edge case: `/artwork` (empty text) → ephemeral usage hint.
- Edge case: rapid double-fire of same command → Inngest dedup by id (`slash-gen:<channel>:<tracker_ts>`) catches the second; only one fal call.
- Error path: invalid signature → 401, no event fired.

**Verification:** Typing `/artwork build-first-agent` in `#content` produces an ephemeral confirmation and, ~60s later, a variants thread in `#content`. Typing the same command in any other channel produces a redirect ephemeral and nothing else happens.

---

- U12. **CLI replay script**

**Goal:** A terminal-friendly trigger that fires the generate event for an existing post by slug, for fast local iteration without Slack roundtrip.

**Requirements:** R15, R17

**Dependencies:** U4, U7

**Files:**
- Create: `scripts/artwork-replay.ts` (or `apps/ai-hero/scripts/artwork-replay.ts`)
- Modify: `package.json` — add `"artwork:replay": "tsx scripts/artwork-replay.ts"` to scripts.
- Test: skip — script is a thin wrapper over `inngest.send`; tested implicitly via the function it triggers (U7).

**Approach:**
- Reads slug or post id from `process.argv[2]`.
- Imports the `inngest` client and `getCachedPostOrList` from `@/lib`.
- Resolves the post, posts a tracker message in `SLACK_CONTENT_CHANNEL_ID` (same shape as U11) for thread anchoring.
- Fires `slack/artwork.generate.requested` with `bypassGuards: true`.
- Logs the event id and exits.

**Test scenarios:**
- Test expectation: none — thin wrapper. Manual smoke verification: `pnpm artwork:replay build-first-agent` produces variants in `#post-artwork`.

**Verification:** Smoke test as above.

---

- U13. **Build `retry-handler` Inngest function**

**Goal:** Wire the Retry button surfaced on failure thread replies to actually re-fire the original event (generate or pick) with `bypassGuards: true` so the in-flight guard doesn't block the retry.

**Requirements:** R12

**Dependencies:** U4, U6, U7, U9

**Files:**
- Create: `src/inngest/functions/artwork/retry-handler.ts`
- Modify: `src/inngest/inngest.config.ts` — register.
- Test: `src/inngest/functions/artwork/__tests__/retry-handler.test.ts`

**Approach:**
- Trigger: `slack/artwork.retry.requested`.
- Idempotency: Inngest event id from U6 (`slack-retry:<channel_id>:<message_ts>`) handles dedup against rapid double-clicks of Retry.
- One step that branches on `event.data.retryStage`:
  - `'generate'` → fire `slack/artwork.generate.requested` with `{ postId, channelId, originalMessageTs, bypassGuards: true }`. The original notification has likely been updated to "❌ Generation failed" with a Retry button — U7's `update-original-to-pending` step will re-update it to "Generating…" cleanly.
  - `'pick'` → fire `slack/artwork.pick.requested` with `{ postId, channelId, threadTs, batchId, variantIndex, falUrl, pickedByUserId }`. U9 retries the Cloudinary upload + cover write end-to-end.
- Step `update-failure-message`: `chat.update` the failure message to remove the Retry button (so the user can't double-click) and replace with "🔄 Retrying…".
- Logs: `void log.info('post.artwork.retry', { postId, retryStage })`.

**Test scenarios:**
- Happy path (generate retry): retry event fires with `retryStage: 'generate'` → `slack/artwork.generate.requested` is dispatched with `bypassGuards: true` → failure message updated to "Retrying…".
- Happy path (pick retry): retry event fires with `retryStage: 'pick'` and full pick context → `slack/artwork.pick.requested` is dispatched.
- Edge case: rapid double-click of Retry → Inngest dedup catches the second; only one downstream event fires.
- Error path: `chat.update` fails (failure message was deleted) → log warning, succeed silently (the downstream event still fires).

**Verification:** Manually trigger a generation failure (e.g., set a bad LoRA URL temporarily); confirm Retry button on the failure message recovers the flow correctly.

---

- U14. **Smoke runbook + flow doc + ADR**

**Goal:** Document the pipeline so the next person (or future-Vojta) can find it and reason about it.

**Requirements:** Plan-quality (success criterion).

**Dependencies:** U1–U13

**Files:**
- Create: `apps/ai-hero/docs/flows/post-artwork-generation.md` — flow doc following the existing flow-doc format in `apps/ai-hero/docs/flows/`. Include the Mermaid diagram from this plan (HLD section), the trigger paths (post-create / Slack button / slash command / CLI), and failure-mode handling.
- Create: `docs/adrs/ADR-0NNN-slack-mediated-artwork-pipeline.md` — ADR capturing the key technical decisions (verify→dispatch→200, queue+webhook for fal, AI SDK gateway, batchId correlation, direct adapter call for cover writes, **no in-pipeline image processing — composition deferred to dynamic OG routes**, **upload-on-pick instead of upload-on-generate**).
- Modify: `apps/ai-hero/.env.example` — add the five new env vars (FAL_API_KEY, FAL_LORA_URL, SLACK_CONTENT_CHANNEL_ID, SLACK_CONTENT_BOT_TOKEN, SLACK_CONTENT_BOT_SIGNING_SECRET) with placeholder values + comments noting where each is sourced from.
- Modify: `apps/ai-hero/README.md` (only if it has a "running locally" section worth extending) — add a one-paragraph "Artwork pipeline" section noting the slash command, CLI script, and Inngest dev UI.

**Test scenarios:**
- Test expectation: none — documentation.

**Verification:** ADR linked from the flow doc; flow doc linked from the README section if added.

---

## System-Wide Impact

- **Interaction graph:** New emission of `RESOURCE_CREATED` from BOTH `posts.service.createPost` (API path) AND `posts-query.createPost` (UI path), with the same idempotency id so Inngest dedupes any double-fire. The only existing consumer (`calendar-sync`) filters to `type === 'event'` and is unaffected. New consumer `notify-on-post-created` filters to `type === 'post'`.
- **Error propagation:** All pipeline failures route to a single `artwork/generation.failed` Inngest event; the failure thread reply (with Retry button) is the user-facing surface. The post is never partially mutated — Cover writes happen in a single `courseBuilderAdapter.updateContentResourceFields` call. Retry is an explicit user action via U13, not an automatic infinite loop.
- **State lifecycle risks:** The `_artwork: { batchId, startedAt }` field on `post.fields` is pipeline-private state, namespaced under a leading-underscore key to signal "internal". It's NOT exposed via `PostUpdateSchema` (Matt's API can't write it). If a post is deleted mid-generation, the wait-for-event step times out (5m) and the failure event fires. No orphan Cloudinary blobs are possible because Cloudinary uploads only happen on Pick (1× per cover, deterministic public_id overwrites on Retry). Un-picked variants stay only on fal's CDN — never in our Cloudinary account. Concurrency limits on U7 and U9 serialize parallel runs against the same post.
- **API surface parity:** `PostUpdateSchema` gains the `coverImage` field (so Matt could eventually set the cover via API), but NOT `_artwork` (pipeline-private). Schema diff is one optional user-facing field.
- **Integration coverage:** Mocked unit tests don't prove the Slack signature flow or fal queue+webhook flow end-to-end; smoke verification per U14 is the gate.
- **Security posture:** Three webhook surfaces total (`/api/slack/interactivity`, `/api/slack/commands`, `/api/fal/webhook`). Slack routes verify against `SLACK_CONTENT_BOT_SIGNING_SECRET`. fal webhook is signal-only; U7's `refetch-fal-status` + `validate-image-urls` steps ensure that even an unsigned forged fal webhook cannot inject malicious URLs into Slack image previews, Cloudinary, or `post.fields.coverImage`. The Pick handler (U9) trusts the `falUrl` carried in the button payload — but that URL was put there by U7 only after passing the hostname allowlist, and the Slack signing-secret verification on U6 ensures the button payload itself is authentic.
- **Unchanged invariants:** `posts.service.updatePost` flow is unchanged. `kit-broadcast-approval` route behavior is unchanged after U3 (helper extraction is behavior-preserving; existing `SLACK_TOKEN`/`SLACK_SIGNING_SECRET` continue to serve it). `notificationProvider.sendNotification` is unchanged. The existing Slack app/bot is untouched — the new content bot is a separate app with its own credentials. The OG-image route at `src/app/api/og/route.tsx` already accepts `image` query param when `resource.type === 'post' && image` — picking up `coverImage.url` is a metadata-side change in `generateMetadata`, not a route change.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| fal credit burn from misclick or runaway loop | In-flight guard (`_artwork.startedAt`), Inngest event-id dedup with channel-id-namespaced keys (24h), Slack 5-min replay window, U7 concurrency limit per postId. Replay triggers (U11/U12) explicitly opt out. |
| **fal webhook signature scheme is undocumented or weak** | **Primary defense (mandatory in U7): always re-fetch image URLs from `fal.queue.status(falRequestId)` and validate hostnames against the fal CDN allowlist before any image is rendered or uploaded.** Webhook is signal-only. |
| Slack 3s ack window violation breaks the loop | Verify path is `verify → inngest.send → 200` only — no inline work. Inngest send is ~50-150ms typical; well under budget. Slack retries within 5 min are deduped via Inngest event id. |
| Stale-batch Pick after Regenerate sets the wrong cover | `batchId` correlation in U9; concurrency-1 limit on U7 ensures `mark-generating` writes land in click-order. |
| Parallel Pick clicks race the cover write | Concurrency-1 limit on U9 serializes Pick writes per post; second pick wins deterministically. |
| Slash command burning fal credits via cross-channel invocation | Channel restriction in U11: `/artwork` only accepts commands from `SLACK_CONTENT_CHANNEL_ID`. |
| **fal URL expires before user clicks Pick** (rare; fal URLs are persistent on `fal.media` but officially "treat as ephemeral") | Cloudinary upload happens in U9 at click-time. If the fal URL is unreachable, U9 fails terminally with a Retry button. The user's recovery path is "Regenerate" — cheap, self-explanatory in the failure message. The window between generation and pick is typically minutes for an active user; staleness is only realistic if a notification sits in the backlog for days. |
| AI SDK gateway model identifier shifts | Pin the model identifier in code via a constant; verify against gateway docs at U7 implementation. |
| `response_url` 30-min expiry stranding feedback for stale notifications | All out-of-band feedback uses `chat.postEphemeral` (no expiry) or fresh `chat.postMessage`, NOT `response_url`. |

---

## Documentation / Operational Notes

- After deploy, capture the Vercel preview URL and update Slack app's Interactivity Request URL + Slash Command Request URL to the production URL.
- Cloudinary will accumulate un-picked variants. Cheap, but a quarterly cleanup script could prune images whose `public_id` matches `post_*_v*` and whose post no longer references them. Not v1.
- Axiom dashboards: a "post artwork" dashboard tracking `post.artwork.notify`, `.generate.requested`, `.fal.completed`, `.variant.picked`, `.failed` would surface the funnel; defer to post-launch.

---

## Sources & References

- **Origin document:** [apps/ai-hero/docs/brainstorms/2026-05-04-slack-artwork-pipeline-requirements.md](../brainstorms/2026-05-04-slack-artwork-pipeline-requirements.md)
- Reference implementation (Python, prompt template only — composite parameters are NOT used in v1): `aihero-design/lora-training/og_articles_v9.py`
- Slack signature pattern reference: `apps/ai-hero/src/app/api/slack/kit-broadcast-approval/route.ts`
- Cover-image field shape reference: `apps/ai-hero/src/lib/workshops.ts` lines 22–27, `apps/ai-hero/src/lib/module.ts:35`
- Direct content-resource update reference: `apps/ai-hero/src/inngest/functions/calendar-sync.ts:346`
- Markdown serialization: `apps/ai-hero/src/lib/markdown-serializer.ts`, `apps/ai-hero/src/app/md/[slug]/route.ts`
- fal docs: https://docs.fal.ai/model-apis/client, https://fal.ai/models/fal-ai/flux-lora/api
- Slack docs: https://docs.slack.dev/authentication/verifying-requests-from-slack, https://docs.slack.dev/reference/methods/chat.postMessage
- Inngest docs: https://www.inngest.com/docs/events, https://www.inngest.com/docs/reference/functions/step-wait-for-event
- Cloudinary remote-URL upload: https://cloudinary.com/documentation/upload_images#remote_image_url
