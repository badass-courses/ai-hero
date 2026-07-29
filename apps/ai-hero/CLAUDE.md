# AI Hero · Claude Code Notes

App-specific rules for `apps/ai-hero/`. The monorepo-wide `CLAUDE.md` at the repo root still applies.

See `./AGENTS.md` for the full agent guide (kept in sync, harness-agnostic).

## If working on UIs, read this

**Before touching any UI in this app, read `./DESIGN.md`.** Applies to anything UI-related: pages, components, layouts, the works. Highlights:

- The normative source is `AI Hero Courses Redesign/aihero.css` at the repo root — a token + pattern spec. Where it and a component disagree, it wins.
- Container has `border-x`; no horizontal padding on section wrappers, pad inner content instead.
- Grid hairlines: `bg-border` + `gap-px` on the grid, `bg-background` on each cell. See `ResourceGrid` in `src/components/landing/resource.tsx`.
- Colors: shadcn semantic tokens only (`border-border`, `text-foreground`, `bg-card`, …), plus the `--ah-fg-*` / `--ah-line*` alpha ramps. Gold fills are `bg-accent-fill`; accent *type* is `text-primary` (ink in light — DESIGN rule 7).
- Sizes come from `TYPE` in `src/components/landing/type.ts`. Do not write size classes inline. Headings are 700.
- Radii: 4 / 6 / 9 / 11 / 12. Page structure stays sharp; `rounded-full` only on circles.
- Light + dark mode both required.
