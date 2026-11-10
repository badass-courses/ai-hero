# C5 signed playback pilot

The pilot selects signed Mux playback IDs only for protected Software Factories lessons under `cohort-xdy1m`. It reuses `getAbilityForResource(...).canViewLesson`. The workshop page rejects denied viewers on the server before loading playback data. The signing module rechecks the same gate before minting.

This is signed playback, not DRM. A copied signed ID needs a valid token. A copied token works until its six-hour expiry. Existing public IDs remain usable by design, so this additive pilot does not close old public links or prevent recording. Removing public IDs needs a separate decision.

## Review and enable

1. Merge the code with `AIH_SIGNED_PLAYBACK_RESOURCES` unset. Nothing selects signed playback in this state.
2. The operator supplies `DATABASE_URL` through the secret runner and runs from `apps/ai-hero`:

   ```sh
   pnpm exec tsx scripts/c5-signed-playback-ids.ts
   ```

   This dry run reads only the cohort content tree. It prints video resource IDs, asset IDs, whether a signed ID exists, and counts. It makes no Mux requests and writes no files. Free-tier relations (including free sections), public lessons, deleted relations and deleted resources are excluded. Inspect the inventory before approving writes.

3. After review, the operator supplies `MUX_ACCESS_TOKEN_ID` and `MUX_SECRET_KEY` and runs one writer:

   ```sh
   pnpm exec tsx scripts/c5-signed-playback-ids.ts --allow-write --snapshot /private/operator-chosen/c5-playback.jsonl
   ```

   The script creates a new snapshot with mode `0600` and refuses to overwrite it. It flushes an intent record before creating a Mux ID, then flushes the returned ID before updating the video resource. The new ID cannot be known before Mux returns it. A crash between those steps is recovered by reading the asset's existing signed IDs on the next run. Never run concurrent writers. Each rerun uses a new snapshot path.

   Existing signed IDs are reused. Resources with `fields.muxSignedPlaybackId` are skipped. Database writes use `JSON_SET` for that field only, require the same asset ID, and read back the signed ID. Public IDs and other video fields are untouched. There are no Mux delete or playback-ID update calls.

4. The operator configures the existing `MUX_SIGNING_KEY_ID` and `MUX_SIGNING_KEY_PRIVATE` (base64 PEM) on the server. This packet neither creates keys nor changes environment values.
5. Set `AIH_SIGNED_PLAYBACK_RESOURCES=cohort-xdy1m` and apply the environment change through the hosting platform's normal process. New authorized lesson requests select signed playback. No other cohort is supported by this pilot.

## Verify

- An entitled C5 viewer gets the signed ID and playback, thumbnail and storyboard tokens in the player. Tokens carry RS256, `kid`, signed ID `sub`, audiences `v`/`t`/`s`, and six-hour expiry.
- A denied viewer redirects before playback lookup or token minting.
- A free/public lesson, another course, or the Crash Course stays on its public ID.
- Switching from a signed lesson to a public source clears player tokens.
- Requesting the signed HLS URL without its token must fail at Mux. Verify this after the operator provisions real assets; unit tests cannot prove the live Mux policy.
- `video.signed_playback.minted` contains only video `resourceId` and signing `ms`.
- Missing keys or crypto failures use the public ID and emit `video.signed_playback.fallback` with `missing_keys` or `mint_failed`. A failed cohort lookup uses `scope_lookup_failed`. Errors and key material are never logged.

## Roll back

Unset `AIH_SIGNED_PLAYBACK_RESOURCES` and apply that environment change. No asset reversal is needed: the original public IDs were never changed. New requests use public playback; existing pages may keep their previously minted tokens until navigation or refresh.

**Hosting caveat:** an environment variable is not a live remote switch. Vercel environment changes require a new deployment to reach running functions. This packet does not claim an instantaneous, no-deploy rollback on Vercel. If that is required, add a separately reviewed runtime flag before enabling the pilot.

## Limits

- Tokens are minted per request, not stored in a shared cache. Pages left open beyond six hours need a refresh to renew tokens; automatic renewal is not part of this pilot.
- Inventory traversal is bounded to eight relation levels and only workshop/section/lesson/exercise/solution/video nodes. Unexpected content shapes need inspection rather than a broader migration.
- The snapshot contains content IDs, never customers. Keep it private and outside Git.
