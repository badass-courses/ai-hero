---
date: 2026-05-04
topic: slack-artwork-pipeline
---

# Slack-Mediated Generative Artwork Pipeline for Posts

## Summary

A Slack-mediated artwork iteration loop for posts: when Matt creates a post via the API, a notification lands in a dedicated Slack channel with a "Generate Artwork" button. Clicking it runs Claude → fal v9 LoRA → branded OG composite to produce 4 variants in-thread; clicking Pick uploads the chosen variant to Cloudinary and stores its durable URL on the post as the public cover image. Plus rapid-test triggers (CLI script + `/artwork` slash command) so the loop can be exercised against any existing post without writing new DB records.

---

## Problem Frame

Aihero posts currently ship without cover art. Matt publishes via the API and never blocks on visuals — the absence of artwork is a polish gap, not a broken flow. Vojta has trained a v9 fal LoRA in the brand's visual vocabulary and built a working OG-composite pipeline (`aihero-design/lora-training/og_articles_v9.py`) that generates images with the right vibe, but the pipeline is local Python, not connected to live posts, and applying it requires manual work outside the course-builder system. The cost shape today: every published post is a missed opportunity for a more compelling OG share/cover, and the gap grows with every new post. The model itself is still being iterated on (v9 is the latest of nine LoRA training rounds), so the loop must support fast experimentation — change the LoRA, regenerate, see results — without churning Matt's publishing flow.

---

## Actors

- A1. **Matt (post author)**: Creates posts via the public API. Should never be blocked or interrupted by the artwork pipeline.
- A2. **Vojta (artwork curator)**: Watches the Slack channel, decides when to generate, picks the best variant. The only human in the artwork loop.
- A3. **Aihero artwork bot**: Posts notifications, exposes buttons, runs generation on click, uploads picked variant, writes to post.
- A4. **fal (image model host)**: Hosts the v9 LoRA and runs FLUX inference per request.
- A5. **LLM (via AI SDK gateway)**: Translates a post's title + body into a short visual-noun hook in the LoRA's vocabulary.
- A6. **Cloudinary (durable image storage)**: Stores the picked variant at a stable URL for use as the post's cover image.

---

## Key Flows

- F1. **Notify on post creation**
  - **Trigger:** `RESOURCE_CREATED` event with `data.type === 'post'`
  - **Actors:** A3
  - **Steps:**
    1. Inngest function consumes the event.
    2. Bot posts a message to the configured Slack channel containing post title, slug, post-type, link to the editor, and a `Generate Artwork` button (plus a `Skip` button so notifications can reach a terminal state without forcing generation).
    3. Message metadata records the post id so the button click can correlate them later.
  - **Outcome:** A new Slack message exists for the post; no fal/LLM cost incurred yet.
  - **Covered by:** R1, R2, R3

- F2. **Generate variants on click**
  - **Trigger:** A2 clicks `Generate Artwork` on a post-notification message
  - **Actors:** A2, A3, A5, A4
  - **Steps:**
    1. Slack POSTs the button-click payload to the new interactivity webhook.
    2. The endpoint verifies the Slack signing secret, extracts the post ID, and emits an internal Inngest event.
    3. Generation Inngest function fetches the post, sends serialized markdown to the LLM with a system prompt tuned to produce a single short visual-noun hook descriptor.
    4. Function calls fal with the v9 LoRA URL, the fixed prompt template, `num_images: 4`, and the same generation parameters used in `og_articles_v9.py`.
    5. For each of the 4 returned images: smart-crop the 1200×293 strip and composite it under the fixed brand-foreground PNG to produce a 1200×630 OG image.
    6. Upload composites for variant display.
    7. Bot posts a thread reply to the original post-notification message containing the 4 variants as image attachments, the hook descriptor used, and `[Pick 1] [Pick 2] [Pick 3] [Pick 4] [🔄 Regenerate]` buttons.
  - **Outcome:** A2 sees 4 candidate OG images in-thread with controls to select or retry.
  - **Failure path:** If LLM, fal, sharp, or Cloudinary fails, bot replies in-thread with the error and a retry option. Post is unaffected.
  - **Covered by:** R4, R5, R6, R7, R8, R12

- F3. **Pick a variant**
  - **Trigger:** A2 clicks `Pick N` on a variant message
  - **Actors:** A2, A3, A6
  - **Steps:**
    1. Slack POSTs the button-click payload; webhook verifies signature and emits an internal Inngest event with post ID and variant index.
    2. Pick Inngest function uploads the selected composite OG image to Cloudinary using the existing image-resource Cloudinary upload pattern.
    3. Function reads the post; the new pick OVERWRITES any existing cover image (warning at notification time is informational only).
    4. Function writes the Cloudinary URL onto the post's cover-image field.
    5. Bot replies in-thread confirming which variant was picked and the resulting cover URL.
  - **Outcome:** The post now has a public cover image rendered as OG / on-site cover. Un-picked variants stay in the Slack thread as ephemeral context.
  - **Covered by:** R9, R10, R11

- F4. **Regenerate**
  - **Trigger:** A2 clicks `🔄 Regenerate` on a variant message
  - **Actors:** A2, A3, A5, A4
  - **Steps:** Same as F2 from step 3 onward. New thread reply with a new batch of 4 variants. Older variant messages remain in-thread as history; their Pick buttons reject as stale-batch when clicked.
  - **Outcome:** A2 has a fresh batch to evaluate; spend grows with click count.
  - **Covered by:** R4, R5, R6, R7, R8

- F5. **Manual replay (CLI or slash command)**
  - **Trigger:** A2 runs `pnpm artwork:replay <slug>` or types `/artwork <post-url-or-slug>` in any Slack channel
  - **Actors:** A2, A3
  - **Steps:** Resolves the post by slug; posts a tracker message to the artwork channel for thread anchoring; fires the same generate event the button click does, with a flag bypassing the in-flight protection guard.
  - **Outcome:** Variants land in the artwork channel exactly as if Generate had been clicked, even though no new post was created.
  - **Covered by:** R15, R16, R17

---

## Requirements

**Notification (post → Slack)**
- R1. The bot posts a Slack message to a new dedicated channel (configured via a new env var like `SLACK_ARTWORK_CHANNEL_ID`, distinct from `SLACK_DEFAULT_CHANNEL_ID`) for every `RESOURCE_CREATED` event where `data.type === 'post'`. No filtering by author, visibility, or state in v1.
- R2. The notification includes post title, slug, post type, a link to the post in the aihero editor, and a `Generate Artwork` button. Clicking the button is the only auto-trigger entry point for generation.
- R3. The notification message persists indefinitely; un-actioned messages form a backlog A2 can work through asynchronously. Notifications reach a terminal state when generation completes, a variant is picked, or A2 clicks Skip.

**Generation (click → variants)**
- R4. Generation only runs when a button click triggers it, or when a manual replay is invoked. There is no auto-generation on post creation, no scheduled batch, no time-window limit.
- R5. Each generation produces exactly 4 variants per click. Per-batch count is fixed in v1, not user-selectable.
- R6. The image prompt is constructed by an LLM from the post's serialized markdown; the LLM returns ONLY the short visual-noun hook descriptor (e.g. `"stacked building blocks and scaffolding shapes"`), and the rest of the fal prompt is the fixed template inherited from the existing v9 generation script.
- R7. fal generation uses the trained v9 LoRA whose URL lives in the aihero-design repo. The active LoRA model is configurable (env var or config), so newer LoRAs can be swapped in without code changes to the generation function.
- R8. Each variant is post-processed into a 1200×630 OG image: a 1200×293 smart-cropped strip of the LoRA-generated art composited under the fixed brand-foreground PNG (logo + portrait). The composition pipeline is functionally equivalent to `aihero-design/lora-training/og_articles_v9.py`.

**Pick (variant → post cover image)**
- R9. Picking a variant uploads that composite to Cloudinary, producing a stable, durable URL.
- R10. The Cloudinary URL is stored on the post in the cover-image field (exact field name to be decided in planning) and rendered as the post's public cover and OG image.
- R11. If the post does NOT have a cover image at the moment the notification fires (F1), generation and pick proceed normally. If the post DOES have a cover image, the bot still posts the notification, but the message includes a `⚠️ Cover already set — picking will overwrite it` indicator. The pick action itself always overwrites the current cover image with the picked variant; precedence is informational, not enforced.

**Failure handling**
- R12. If LLM or fal fails during generation, the bot replies in the Slack thread with the error summary and a retry option. The post is never modified on generation failure. If Cloudinary upload fails on pick, the bot replies with the error and a retry option; the post's cover image is not touched.

**Slack interactivity infrastructure**
- R13. The ai-hero app exposes a single Slack interactivity HTTP endpoint that verifies the Slack signing secret on every request and dispatches button-click payloads as internal Inngest events. This is the only inbound Slack interactivity route the v1 pipeline introduces (the slash command lives at a separate route).
- R14. Channel-membership IS the access control for buttons. Any user in the configured Slack channel can press any button. v1 does not check Slack user identity against post ownership or aihero user roles.

**Rapid-test triggers**
- R15. A CLI script accepts a slug and fires the same Inngest event the post-create path emits, allowing iteration against any existing post without DB writes.
- R16. A Slack slash command `/artwork <post-url-or-slug>` does the same from anywhere with Slack access. Accepts full URLs or bare slugs. Lives at a separate route from interactivity.
- R17. Both replay triggers bypass the in-flight protection guard and the "cover already set" warning so the same post can be regenerated repeatedly during iteration.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given the aihero artwork bot is configured for channel `#post-artwork`, when Matt creates a new post titled "Choosing the Right LLM for Your Agent" via the API, then within ~10s a message appears in `#post-artwork` with the title, the slug, a link to the editor, and a `Generate Artwork` button.

- AE2. **Covers R4, R5, R6, R7, R8.** Given a post-notification message exists for "Choosing the Right LLM for Your Agent", when Vojta clicks `Generate Artwork`, then the LLM is called with title + body, fal is called with the v9 LoRA and `num_images: 4`, four 1200×630 OG composites are produced (each with the brand foreground over a unique LoRA strip), and a thread reply appears containing all four images, the hook descriptor used, and Pick/Regenerate buttons. The post itself is unchanged.

- AE3. **Covers R9, R10.** Given a thread reply with four variants exists, when Vojta clicks `Pick 3`, then variant 3's composite is uploaded to Cloudinary, the resulting URL is written to the post's cover-image field, and the bot replies in-thread "Picked variant 3 → \<cloudinary-url\>".

- AE4. **Covers R11.** Given a post already has a cover image set, when the post is updated in a way that fires `RESOURCE_CREATED` again — or when a fresh post with a manually-set cover is created — the bot still posts the Slack notification, but the notification text includes `⚠️ Cover already set — picking will overwrite it`. If Vojta proceeds and clicks Pick, the existing cover is replaced with the picked variant.

- AE5. **Covers R12.** Given Vojta clicked Generate Artwork and fal returned a 500 mid-batch, when the generation function catches the error, then the bot replies in-thread "Generation failed: \<error summary\> — try again?" with a retry option, and the post is not modified.

- AE6. **Covers R14.** Given a contractor with view access to `#post-artwork` clicks `Pick 2` on a variant message, the pick proceeds and the post's cover image is updated. v1 does not verify the clicker's identity against aihero user roles or post ownership; channel access IS the gate.

---

## Success Criteria

- Matt's API publishing experience is unchanged. He continues to ship posts at the same cadence and never sees an error, slowdown, or new required field.
- Within the first month, at least 50% of newly created posts end up with a picked LoRA-generated cover image.
- Vojta can swap in a newer LoRA (v10, v11) by changing one config value and pressing Regenerate on existing posts, without touching the codebase or redeploying generation logic.
- Slack thread per post serves as a useful artifact: reading a thread tells the story of what variants were considered and why the picked one won.
- A downstream agent or implementer can execute this brainstorm into a working pipeline without inventing scope: trigger semantics, variant count, prompt strategy, picker UX, storage destination, failure modes, and access-control model are all specified here.

---

## Scope Boundaries

- Auto-generation on post create. Generation only runs on Vojta's button click or replay trigger in v1.
- Resource types other than posts: lessons, workshops, cohorts, lists, embeds. Posts only for v1.
- Editing the LLM-generated hook descriptor from inside Slack before regen. Defer until we observe whether the descriptors actually need correction in practice.
- Persisting un-picked variants on the post (variant gallery / history field). Only the picked variant's URL is stored on the post.
- Promoting or comparing previously-picked variants across posts.
- Per-day, per-month, or per-post fal cost caps and budget alarms. Spend control in v1 = Vojta's click cadence.
- Web UI for picking variants. Slack is the entire picker UX for v1.
- Surfacing pending or in-progress artwork in the API response. Matt only sees results when he re-fetches the post and finds the cover image populated.
- Slack user identity → aihero user identity mapping. Anyone with channel access can press buttons; channel membership IS access control.
- The deeper API-integrated flow ("once we're happy with the model, integrate more deeply"). Explicitly future work, not v1.

---

## Key Decisions

- **Slack as the picker UX, not the post API.** Decouples two unknowns — "is the LoRA any good?" and "what's the picker UX?" — so the model can be iterated on without rebuilding picker UX.
- **Generation is gated behind a click, not the create event.** Avoids burning fal credits on draft/throwaway posts and on posts Matt is iterating on rapidly.
- **4 variants per generation, fixed.** Enough surface to choose from in one batch, low enough cost to click freely.
- **LLM produces only the visual-noun hook, not the full prompt.** Keeps the LLM call small and cheap, and ensures the LoRA's required style guardrails always apply regardless of what the LLM produces.
- **Picked variant overwrites the current cover.** Pick is a deliberate action; the user clicked it knowing the warning.
- **Channel membership = access control.** No per-user permission check in v1.
- **Async-first; never blocks Matt.** The loop's cost-of-failure is "post ships without cover," which is the current default state.
- **Variant images live in Slack threads as the history record.** No separate variant-history table or gallery UI.
- **LLM input source: serialized markdown via the existing /md/[slug] serializer.** Same canonical text the AI-friendly route serves; not raw post.fields.body.

---

## Dependencies / Assumptions

- The trained v9 LoRA URL on fal is stable and reachable from the ai-hero serverless environment.
- The fixed brand-foreground PNG (`aihero-design/assets/example-og-foreground-1200x630.png`) is the canonical asset to ship with v1. Either it gets committed into the ai-hero app, or it's hosted at a stable URL the generation function can fetch.
- The existing `image-resource-created` Cloudinary upload pattern in the ai-hero app can be reused or generalized for OG composites.
- Aihero already has an AI SDK gateway setup; the LLM prompt-translation call uses the same path.
- Image post-processing (smart crop, RGBA composite) is doable in TypeScript / Node with sharp.
- A Slack app config (or extension of the existing app) is required: Interactivity Request URL, Slash Command Request URL, signing-secret env var, additional bot scopes.
- A new dedicated Slack channel (e.g. `#post-artwork`) is created for post-artwork notifications, separate from `SLACK_DEFAULT_CHANNEL_ID`. Its ID is configured via a new env var (e.g. `SLACK_ARTWORK_CHANNEL_ID`).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R10][Technical] Exact name and shape of the cover-image field on the post. Determined during planning by checking what the post-rendering paths currently look up.
- [Affects R12][Technical] Should generation/pick failures be retried automatically (Inngest's built-in retry) or only via the explicit retry button?
- [Affects R8][Needs research] Best Node library for the smart-crop + RGBA composite step. `sharp` is the obvious candidate.
- [Affects R7][Needs research] Where the v9 LoRA URL config should live in ai-hero (env var vs a config file vs a database row).
- [Affects R13][Technical] Whether the existing Inngest Slack patterns in other apps provide reusable scaffolding for the interactivity webhook → Inngest event hop.
