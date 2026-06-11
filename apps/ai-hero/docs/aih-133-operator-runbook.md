# AIH-133 operator runbook

## Do this first

Run preview. Do not write first.

```bash
pnpm subscriber-marketing:operator content-read-event-preview --limit 100 --sample-limit 10
```

These rows come from `AI_ContentRead`. They are database rows, not logs.

## When to hold writes

Hold writes when `eligibleCount` is `0`.

Hold writes when skipped rows are mostly:

- `anonymous-session-only`, we do not know who read it.
- `kit-subscriber-unresolved`, Kit ID is not linked to a Contact yet.
- `missing-trusted-identity`, logged-in user is not linked to an AI Hero Contact
  yet.
- `email-hash-unresolved`, hash alone is not enough.

## When to write

Only write after reviewing eligible samples.

Use a tiny batch:

```bash
pnpm subscriber-marketing:operator content-read-event-preview --allow-write --limit 5 --sample-limit 5
```

Large writes are blocked unless a human-reviewed backfill uses
`--force-large-write`.

## Shortlink clicks

Preview shortlink clicks separately:

```bash
pnpm subscriber-marketing:operator shortlink-click-event-preview --limit 100 --sample-limit 10
```

Shortlink metadata is summarized through allowlisted fields only. Raw blobs are
not copied into Contact Events.

## Logged-in AI Hero user identity linking

Link logged-in readers from staged Content Reads:

```bash
pnpm subscriber-marketing:operator link-ai-hero-user-identities --allow-write --limit 25
```

This creates or reuses an `AI_Contact` and creates an `ai-hero` provider
identity for `AI_ContentRead.userId`. It does not promote anonymous reads.

## Kit identity linking

Link trusted Kit subscribers only through verified Kit subscriber lookup:

```bash
pnpm subscriber-marketing:operator link-kit-subscriber-identities --allow-write --limit 25
```

This does not write Kit. It only writes Course Builder Durable Truth records.

## Anonymous retention

Dry-run cleanup:

```bash
pnpm subscriber-marketing:operator content-read-retention --retention-days 14
```

Write cleanup:

```bash
pnpm subscriber-marketing:operator content-read-retention --retention-days 14 --allow-write
```

Only anonymous rows older than the cutoff are deleted.

## Receipt

Generate a redacted read-only receipt:

```bash
pnpm subscriber-marketing:operator aih-133-production-receipt --limit 100
```

The receipt is safe to paste into Linear.
