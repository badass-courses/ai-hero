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
