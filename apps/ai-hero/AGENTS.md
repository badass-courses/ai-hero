# AI Hero · Agent Guide

This file applies to any agent working inside `apps/ai-hero/`. The monorepo-wide guide lives at the repo root in `AGENTS.md`/`CLAUDE.md`; this one adds app-specific rules.

## If working on UIs, read this

**Before touching any UI in this app, read `./DESIGN.md`.** It is short and binding. Applies to anything UI-related: pages, components, layouts, the works.

Key rules (full detail in `DESIGN.md`):

- The normative source is `AI Hero Courses Redesign/aihero.css` at the repo root — a token + pattern spec. Where it and a component disagree, it wins.
- The container owns `border-x`; section wrappers must not add horizontal padding, padding goes on inner content.
- Grids use `bg-border` + `gap-px` to draw hairlines. Never put borders on individual cells. See `ResourceGrid` in `src/components/landing/resource.tsx`.
- Colors come from shadcn semantic tokens only (`border-border`, `text-foreground`, `bg-card`, …), plus the `--ah-fg-*` / `--ah-line*` alpha ramps. No raw hex, no raw Tailwind palette. Gold fills are `bg-accent-fill`; accent *type* is `text-primary`, which is ink in light mode (DESIGN rule 7).
- Sizes come from `TYPE` in `src/components/landing/type.ts` — do not write size classes inline. Headings are 700.
- Radii: 4 / 6 / 9 / 11 / 12. Page structure stays sharp; `rounded-full` only on genuine circles.
- Both light and dark mode must work for every change.

## Customer-facing surface changes: Matt gets a heads-up

**Standing rule (Matt + Joel, 2026-07-16.)** Any change to a customer-facing surface — CTAs, landing pages, signup flows, email copy, pricing pages — ships with a **non-blocking heads-up to Matt in Slack `#cc-matt-p`** (eggheadio, channel `C0211NSK3TP`), before or at ship. Matt: "feel free to experiment, just need a non-blocking heads up when things change." His socials point at these surfaces; silent changes make his callouts wrong.

Non-blocking means: post the note and ship — never wait for a reply. One or two sentences: what changed, where, why, and how it's monitored. Agents without a Slack posting lane put the drafted note in front of Joel instead of skipping it.

## Stripe and commerce testing

Read this before any checkout, coupon, credit, invoice, webhook or fulfilment test.

- **Never test payments on a Vercel preview.** Production, Preview and Development share one database and the same live Stripe keys. A preview checkout charges real money and writes to the production database.
- **Never test with env pulled from Vercel.** `vercel env pull` brings the live keys into `.env.local`. Use that file to boot the app, not to test payments.
- **Test keys only.** Use a key that starts with `sk_test_` or `rk_test_`, and refuse anything else. Prefer a restricted `rk_test_` key. Get one from the team's named sandbox (the operator holds the key in the secret store), or make a throwaway one with `npx -y @stripe/cli sandbox create --non-interactive`.
- **Never run `stripe login` on an agent machine.** Pass `--api-key` on every Stripe CLI call.
- **Forward webhooks with the CLI.** Run `stripe listen --api-key <test key> --forward-to localhost:3000/<Course Builder webhook route>` and use the signing secret it prints. The route sits under `src/app/api/coursebuilder/`. Don't create dashboard webhook endpoints for local tests.
- **Use synthetic fixtures.** Test users are `*@example.test` only. Never use real customer accounts, production data dumps or the production database.
- **Label test objects.** Put `metadata.rig=aihero-commerce` and `metadata.rig_run=<run id>` on every object a test creates, so a reset can archive them.
- **Know what a test proves.** A sandbox checkout at the expected total, paid with a test card, with the webhook, purchase and access rows read back, proves the price and the fulfilment. A $1 live charge proves only transport and webhook delivery. It never proves a price.
- **The commerce rig is in progress.** It lands under `apps/ai-hero/scripts/commerce-rig/`. Until it merges, follow these rules by hand.
