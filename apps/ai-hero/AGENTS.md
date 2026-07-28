# AI Hero · Agent Guide

This file applies to any agent working inside `apps/ai-hero/`. The monorepo-wide guide lives at the repo root in `AGENTS.md`/`CLAUDE.md`; this one adds app-specific rules.

## If working on UIs, read this

**Before touching any UI in this app, read `./DESIGN.md`.** It is short and binding. Applies to anything UI-related: pages, components, layouts, the works.

Key rules (full detail in `DESIGN.md`):

- The container owns `border-x`; section wrappers must not add horizontal padding, padding goes on inner content.
- Grids use `bg-border` + `gap-px` to draw hairlines. Never put borders on individual cells. See `ResourceGrid` in `src/components/landing/resource.tsx`.
- Colors come from shadcn semantic tokens only (`border-border`, `text-foreground`, `bg-primary`, `text-primary-foreground`, …). No raw hex, no raw Tailwind palette.
- Headings (`h1`/`h2`/`h3`) use `tracking-tight` and tight leading.
- Both light and dark mode must work for every change.

## Customer-facing surface changes: Matt gets a heads-up

**Standing rule (Matt + Joel, 2026-07-16.)** Any change to a customer-facing surface — CTAs, landing pages, signup flows, email copy, pricing pages — ships with a **non-blocking heads-up to Matt in Slack `#cc-matt-p`** (eggheadio, channel `C0211NSK3TP`), before or at ship. Matt: "feel free to experiment, just need a non-blocking heads up when things change." His socials point at these surfaces; silent changes make his callouts wrong.

Non-blocking means: post the note and ship — never wait for a reply. One or two sentences: what changed, where, why, and how it's monitored. Agents without a Slack posting lane put the drafted note in front of Joel instead of skipping it.
