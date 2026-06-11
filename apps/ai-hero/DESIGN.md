# AI Hero · Design Language

Short rules. Read before touching any UI in this app: pages, components, layouts, the works. The landing page is the canonical reference (`src/app/page.tsx` and `src/components/landing/`); these rules apply everywhere else too.

---

## Register and color strategy

This is a **brand-leaning** product. The landing page is the product face. Marketing surfaces lead aesthetic decisions; app surfaces inherit them.

Color strategy is **Restrained plus abstract accents**:

- Tinted neutrals carry 90%+ of every surface. Token-driven, no raw hex.
- Two or three places in the whole experience earn a colorful moment (hero artwork, signature hover, painted divider, gold stars). Listed in section 9 below.
- If a new component needs color to read, the design is wrong before the color question.

---

## Layout and structure

### 1. The container owns the side borders

The app container has `border-x` (see `src/components/layout-client.tsx`). Every child section bleeds to those edges. No horizontal padding on parents that wrap a section.

- Padding lives on the **inner content**, not on the section wrapper.
- Section dividers come from `border-t` / `border-b` / `border-y` on the section itself, so consecutive sections share a single hairline.

```tsx
✅  <section className="border-b">
      <div className="px-8 py-20 sm:px-16">…</div>
    </section>

❌  <section className="border-b px-8 py-20">…</section>   // pulls content away from the container's border-x
```

### 2. Grids draw hairlines with `bg-border`, never doubled borders

When laying out a grid of cards, do not put borders on each cell. Use the grid container as the line layer:

- Container: `border-border bg-border grid gap-px border-y` (plus `grid-cols-*`)
- Each cell: its own background (`bg-background`, `bg-card`, etc.) so the 1px gaps show through as hairlines.
- Pad short rows with `aria-hidden` `bg-background` filler divs so the trailing line stays clean.

Reference: `ResourceGrid` in `src/components/landing/resource.tsx`.

### 3. Spacing scale

Sections breathe. Use these values, not freehand padding:

| Role | Mobile | Desktop |
|------|--------|---------|
| Section vertical | `py-16` to `py-20` | `md:py-24` |
| Section horizontal | `px-8` | `sm:px-16` (`lg:pl-32` for hero-style insets) |
| Interior content gap | `gap-4` to `gap-6` | `md:gap-8` to `md:gap-16` |
| Inline element gap | `gap-2` to `gap-3` | same |

Pick one row per surface; do not mix `py-12` with `py-20` siblings.

### 4. Two-column grids are intentionally asymmetric

Editorial two-column splits use a single ratio system:

- **Standard editorial** (heading + long body): `md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]`. See `Manifesto`.
- **Balanced editorial** (image / video parity with text): `md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]`. Visually near 50/50; use only when both columns carry equal weight (`Hero`).

Do not invent new ratios. Default to 1.4 unless the right column is genuinely a peer.

### 5. `bg-stripes` for structural gutters

Outside the container on desktop, vertical strips of `.bg-stripes` flank the layout (`LayoutClient`). This treats off-canvas space as decoration, not negative space. Reuse this only for **structural** surfaces: gutters, side rails, non-content fills.

### 6. `bg-stripes` for empty image slots

Inside content, `bg-stripes` is the placeholder for missing images (resource cards and rows). Pair it with a centered uppercase mono label when a label is meaningful, otherwise leave it pure stripes. Never use a flat gray box.

Two utilities exist in `globals.css`:

- `.bg-stripes` (10% diagonal) for visible placeholders.
- `.bg-stripes-muted` (5% diagonal) for subtler structural fills.

---

## Color and theming

### 7. Colors come from shadcn tokens, always

Tokens live in `src/styles/globals.css` as OKLCH values. Never hardcode hex. Never use raw Tailwind palette colors (`text-zinc-500`, `bg-neutral-900`).

Use the semantic tokens:

- Surfaces: `bg-background`, `bg-card`, `bg-muted`, `bg-popover`, `bg-primary`, `bg-secondary`, `bg-accent`, `bg-destructive`
- Text: `text-foreground`, `text-muted-foreground`, `text-primary-foreground`, `text-card-foreground`
- Lines: `border-border`, `ring-ring`
- Always pair a foreground with its surface: `bg-primary text-primary-foreground`, `bg-card text-card-foreground`.

Opacity utilities on tokens are encouraged for secondary text: `opacity-60`, `opacity-70`, `opacity-80`, or `text-foreground/70`, `border-foreground/20`.

> **Known asymmetry.** Today, light-mode `--primary` is pure black; dark-mode `--primary` is the brand gold (`oklch(0.85 0.13 79)`). `YellowStrong` therefore looks gold only in dark and black in light. This is a deliberate current state, not a token to copy. If a new component depends on yellow in both themes, raise it before shipping.

### 8. Both light and dark must work

Every change is reviewed in both modes. Toggle the theme during dev and verify before opening a PR.

- Token-based colors handle this for free, which is why rule 7 exists.
- If a `dark:` branch is genuinely needed, keep both sides token-based. Avoid raw palette colors in either branch.

### 9. Abstract colorful accents, used sparingly

Color earns its place in **four** places. Adding a fifth requires a design conversation.

| Where | What | File |
|-------|------|------|
| Hero artwork | Abstract painted/geometric illustration | `/public/landing/hero@2x.png` |
| Resource row hover | Animated rainbow gradient (oklch) revealed behind a 5px `bg-background` inset | `src/components/landing/resource-row.tsx` |
| Section divider | Painted horizontal stripe (h-1.5 mobile, h-3 desktop) | `/public/landing/colorful-stripe.jpg` |
| Star ratings | Gold `#ffcf77` on the `Star` glyph | `src/components/landing/draft-testimonial.tsx` |

Why `#ffcf77` exists as a hardcoded hex: Lucide stars need a warmer, lower-chroma gold than `--primary` for legibility against both backgrounds. If Lucide is replaced or the token system gains a `--star`, this exemption goes away.

Color makes things pop; everything else stays monochrome on tokens.

---

## Typography

### 10. Fonts

- **Sans (default):** Geist, loaded via `next/font/google` in `src/app/layout.tsx`, exposed as `--font-geist`.
- **Mono:** Geist Mono, exposed as `--font-geist-mono`. Reserved for labels, prices, badges, code.
- Body className applies `font-sans`. Components opt into `font-mono` for the cases above.

### 11. Type scale

Steps follow a roughly 1.25 ratio across major breakpoints. The full landing scale:

| Role | Pattern |
|------|---------|
| Hero h1 (display) | `text-5xl lg:text-6xl font-normal leading-[1.05] tracking-tight` |
| Hero subtitle | `text-2xl font-light leading-tight tracking-tight opacity-70` |
| Section h2 | `text-3xl sm:text-4xl font-medium leading-tight tracking-tight` |
| Centered standalone h2 (`SectionHeading`) | same scale, `font-semibold` |
| Card / row h3 | `text-2xl sm:text-3xl font-semibold leading-tight tracking-tight` |
| Body | `text-base sm:text-lg leading-relaxed opacity-80` |
| Micro-label (mono caps) | `font-mono text-[11px] font-medium uppercase tracking-wider opacity-60` |
| Price | `font-mono` (numerals and currency intentional) |

When to use which h2:
- **Centered standalone** (`SectionHeading`) introduces a section that has no body column. Heavier weight (`semibold`) anchors it.
- **Section h2 inside a two-column editorial grid** (Manifesto, AboutMatt, Newsletter) sits next to body text. Lighter weight (`medium`) reads as a peer to the prose.

Other typography rules:

- **Body measure:** cap reading columns at 65 to 75ch. Long prose blocks already do this; don't widen them in new layouts.
- **`text-balance` on headings and blockquotes that wrap.**
- **Display headings are deliberately lighter and larger** (h1 is `font-normal`). Card titles invert the relationship (heavier and shorter) because they need to anchor a smaller block.
- Never let headings render with default Tailwind tracking. They look loose and generic.

---

## Shape, motion, interactivity

### 12. Square by default

This UI is square. Avoid `rounded-md` and `rounded-lg` on cards, buttons, inputs, images. Newsletter inputs explicitly override default radii with `rounded-none` (see `slim-newsletter-form.tsx`).

The only sanctioned rounded shapes:

- `rounded-full` for avatars, dots, and small pill badges (`DiscountBadge`, `EditorialBadge`).
- `rounded` (small radius) on inline `<code>` inside body copy.

If a designer hands over rounded cards, push back or treat as a documented exception.

### 13. Hover patterns, signature first

The signature interaction is the **resource row gradient frame**. Everything else supports it.

1. **Resource row gradient frame** (signature). On hover, an animated rainbow oklch gradient is revealed behind a 5px `bg-background` inset, producing a thin colorful border. Used on every `ResourceRow`. Reference: `src/components/landing/resource-row.tsx`.
2. **AnimatedArrowCircle** (signature). A circle outline draws itself via `pathLength` animation around a static `ArrowRight`. Use on any "view more / open" link in editorial layouts.
3. **Image scale** (support). `group-hover:scale-105` for rows, `scale-[1.02]` for cards. Slow, subtle.
4. **Card brightness** (support). `hover:brightness-110` on whole-card links when no other affordance fits.

### 14. Motion defaults

- **Default easing:** `[0.22, 1, 0.36, 1]` (ease-out-quart). Use for reveals, fades, scales: anything that has one direction of meaning.
- **In-out exception:** `[0.65, 0, 0.35, 1]` for reversible transitions (a panel that slides open and closed). The current hover gradient on `ResourceRow` uses in-out because it animates back when the cursor leaves; that is the documented exception, not the default.
- **Default duration:** 300 to 500ms for hover effects (`0.4s` is the existing standard). Image scale runs slower (`duration-500`) on purpose.
- **No bounce, no elastic, no spring overshoot** in this brand.

### 15. Empty and loading states

Use `bg-stripes` (rule 6) plus a centered mono placeholder string when the slot is meaningful. Do not render gray skeletons in editorial content.

---

## Accessibility

### 16. Focus rings

Use `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`. Token-based, never raw color. Never remove the outline without replacing it.

### 17. Reduced motion

Respect `prefers-reduced-motion`. The signature gradient frame and arrow-circle reveal both run on hover and should suppress to a static state when reduced motion is set. Add a guard in any new motion component.

### 18. Theme verification

Every PR is checked in both themes before merge. The light-mode primary asymmetry (rule 7 callout) means yellow accents must be re-verified by eye, not assumed.

---

## Bans

Match-and-refuse list. If you are about to ship one of these, redesign the element.

- **Side-stripe borders.** A colored `border-l` or `border-r` thicker than 1px as a card or alert accent.
- **Gradient text.** `background-clip: text` on a gradient is decorative, never meaningful. Use weight or size, or `text-primary` if dark mode.
- **Glassmorphism as default.** Blurred translucent cards used decoratively. Rare and purposeful, or nothing.
- **Hero-metric template.** Big number, small label, supporting stats, gradient accent. SaaS cliché.
- **Identical card grids.** Same-sized cards with icon + heading + text repeated endlessly. The landing already varies between row and card variants on purpose.
- **Modal as first thought.** Exhaust inline and progressive alternatives first.
- **Pure `#000` or `#fff`.** Tokens are tinted neutrals. Stay there.
- **Em dashes in copy.** Use commas, periods, colons, semicolons, or parentheses.
- **Rounded cards.** See rule 12.
- **Bouncy / springy motion.** See rule 14.

---

## Quick checklist before opening a UI PR

- [ ] No `px-*` / `mx-*` on section wrappers that sit directly in the container
- [ ] Grid hairlines come from `bg-border` + `gap-px`, not per-cell borders
- [ ] Spacing values match the table in rule 3
- [ ] Two-column grids use the documented ratios in rule 4
- [ ] Colors come from shadcn tokens; documented exceptions only (rule 9)
- [ ] Headings have `tracking-tight` + tight leading; mono micro-labels where appropriate
- [ ] Body columns capped near 65 to 75ch
- [ ] No stray `rounded-md` / `rounded-lg`
- [ ] Empty image slots use `bg-stripes`
- [ ] Motion uses ease-out-quart by default; reduced-motion guarded
- [ ] Focus-visible rings present on every interactive element
- [ ] Verified in both light and dark mode
- [ ] No banned patterns (see Bans section)
