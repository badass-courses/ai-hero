# AI Hero · Claude Code Notes

App-specific rules for `apps/ai-hero/`. The monorepo-wide `CLAUDE.md` at the repo root still applies.

See `./AGENTS.md` for the full agent guide (kept in sync, harness-agnostic).

## If working on UIs, read this

**Before touching any UI in this app, read `./DESIGN.md`.** Applies to anything UI-related: pages, components, layouts, the works. Highlights:

- Container has `border-x`; no horizontal padding on section wrappers, pad inner content instead.
- Grid hairlines: `bg-border` + `gap-px` on the grid, `bg-background` on each cell. See `ResourceGrid` in `src/components/landing/resource.tsx`.
- Colors: shadcn semantic tokens only (`border-border`, `text-foreground`, `bg-primary`, `text-primary-foreground`, …).
- Headings get `tracking-tight` (and tight leading where appropriate).
- Light + dark mode both required.
