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

The app container is **1440px** wide (`--ah-shell` in the spec) and has `border-x` (see `src/components/layout-client.tsx`). Every child section bleeds to those edges. No horizontal padding on parents that wrap a section.

The desktop horizontal gutter is **44px** (`--ah-gut`), 18px on mobile. Vertical section padding is 52px. Anything inside the shell pads to those values rather than inventing its own.

- Padding lives on the **inner content**, not on the section wrapper.
- Section dividers come from `border-t` / `border-b` / `border-y` on the section itself, so consecutive sections share a single hairline.

```tsx
✅  <section className="border-b">
      <div className="px-[18px] py-20 sm:px-11">…</div>
    </section>

❌  <section className="border-b px-8 py-20">…</section>   // pulls content away from the container's border-x
```

### 2. Grids draw hairlines with `bg-border`, never doubled borders

When laying out a grid of cards, do not put borders on each cell. Use the grid container as the line layer:

- Container: `border-border bg-border grid gap-px border-y` (plus `grid-cols-*`)
- Each cell: its own background (`bg-background`, `bg-card`, etc.) so the 1px gaps show through as hairlines.
- Pad short rows with `aria-hidden` `bg-background` filler divs so the trailing line stays clean.

Reference: `ResourceGrid` in `src/components/landing/resource.tsx`.

**There are three line weights, and `border-border` is the lightest of them.** Reaching for the wrong one is the most common way this design drifts, because a divider one step too heavy reads as a card outline:

| use | token | class |
| --- | --- | --- |
| Section dividers, grid gaps, nav and footer rules | `--border` (= the spec's `--ah-line`) | `border-border`, `bg-border` |
| Card outlines, inputs, chips, ghost buttons | `--input` (= `--ah-line-strong`) | `border-input` |
| Dividers *inside* a list or card | `--ah-line-soft` | `border-[color:var(--ah-line-soft)]` |

Do not hand-write `border-[color:var(--ah-line)]` — that is what `border-border` already is. Mixing the two in one view is what makes neighbouring hairlines look mismatched.

### 3. Spacing scale

Sections breathe. Use these values, not freehand padding:

| Role | Mobile | Desktop |
|------|--------|---------|
| Section vertical | `py-12` to `py-16` | `md:py-[52px]` (`--ah-section`) |
| Section horizontal | `px-[18px]` | `sm:px-11` (44px, `--ah-gut`) |
| Interior content gap | `gap-4` to `gap-6` | `md:gap-8` to `md:gap-16` |
| Inline element gap | `gap-2` to `gap-3` | same |

Pick one row per surface; do not mix `py-12` with `py-20` siblings.

**The desktop gutter is 44px, not 64.** `sm:px-16` predates the redesign and is gone from `src/` — it did not line up with the nav, the footer or any section written against the spec, and a page mixing the two had a visibly ragged left edge. Do not reintroduce it, and do not override the gutter upward at a larger breakpoint (`lg:px-24` and friends): 44px holds at every desktop width. A block may inset *less* than the gutter when its content wants the width — the certificate image on `/certificates/[slug]` is `px-4 sm:px-8` — but never more.

**Mobile is 18px (`px-[18px]`), the spec's value.** This rule used to say the opposite — that mobile stayed at `px-8` because 18px read as cramped. It was wrong in practice for two reasons. 32px eats a sixth of a 390px screen, which costs a word a line at the body measure; and the nav and footer were both already on 18px, so every page had its chrome and its content on different gutters, with the seam visible wherever a full-width band met the header. Converged on 18px across all 76 gutter sites (2026-07-29). The desktop half is unchanged.

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

Tokens live in `src/styles/globals.css`, transcribed from the redesign's
normative spec (`AI Hero Courses Redesign/aihero.css`). **That file wins any
disagreement.** Never hardcode hex in a component. Never use raw Tailwind
palette colors (`text-zinc-500`, `bg-neutral-900`).

The palette is four warm-neutral surfaces, one ink with an alpha ramp, one
accent, and three line levels:

| Role | Dark | Light | Token |
|------|------|-------|-------|
| Page | `#0b0b0b` | `#fbfbfc` | `bg-background` |
| Raised band / sidebar | `#0d0d0c` | `#f5f6f8` | `bg-muted`, `bg-popover` |
| Card / input / code | `#100f0e` | `#ffffff` | `bg-card` |
| Ink | `#f4f3f1` | `#14161a` | `text-foreground` |
| Accent | `#f5c451` on `#191510` | same fill | `bg-accent-fill` |
| Lines | `white/.08`, `.12`, `.06` | `ink/.10`, `.14`, `.07` | `border-border`, `--ah-line*` |

The ink and line ramps are alpha steps rather than palette entries, so they
stay raw custom properties: `--ah-fg-body` (long-form prose), `--ah-fg-muted`
(card descriptions), `--ah-fg-subtle` (meta and bylines), `--ah-fg-label`
(eyebrows), `--ah-fg-faint` (placeholders and decorative numerals only).
Consume them as `text-[color:var(--ah-fg-muted)]` where no semantic token
already says the same thing.

> **The ramp is raised above the spec's alphas, on purpose.** `aihero.css`
> lists .72 / .62 / .48 / .45 / .35, but its own definition of done requires
> WCAG AA "for body copy and all labels ≥ 9.5px" — and at those alphas
> `--ah-fg-label` measures 2.94:1 in light and 3.53:1 in dark, and the eyebrow
> it draws is exactly the label the criterion is about. Every step that carries text now
> passes 4.5:1; `--ah-fg-faint` keeps the spec's value because it never draws
> text a reader has to make out. Do not "restore" the spec's numbers without
> re-reading that criterion.

Use the semantic tokens:

- Surfaces: `bg-background`, `bg-card`, `bg-muted`, `bg-popover`, `bg-primary`, `bg-secondary`, `bg-accent`, `bg-destructive`
- Text: `text-foreground`, `text-muted-foreground`, `text-primary-foreground`, `text-card-foreground`
- Lines: `border-border`, `ring-ring`
- Always pair a foreground with its surface: `bg-primary text-primary-foreground`, `bg-card text-card-foreground`.

Opacity utilities on tokens are encouraged for secondary text: `opacity-60`, `opacity-70`, `opacity-80`, or `text-foreground/70`, `border-foreground/20`.

> **`--primary` and `--accent-fill` are two different jobs.** The spec has two
> rules that a single accent token cannot satisfy at once: the yellow **fill**
> does not change between themes, and accent **text** in light mode is ink
> (`#14161a`), never a darkened yellow — a dark-yellow text token reads as
> brown on paper.
>
> So `--primary` carries the text-safe value (gold in dark, ink in light) and
> `--accent-fill` carries the gold that must survive both themes. Use
> `text-primary` for accent type, and `bg-accent-fill
> text-accent-fill-foreground` for CTA fills and badges.

### 8. Both light and dark must work

Every change is reviewed in both modes. Toggle the theme during dev and verify before opening a PR.

- Token-based colors handle this for free, which is why rule 7 exists.
- If a `dark:` branch is genuinely needed, keep both sides token-based. Avoid raw palette colors in either branch.

Three states in the spec genuinely invert rather than re-tint, because rule 7 takes the accent to ink in light and an ink-on-paper "accent" is invisible unless something else carries it:

| state | dark | light |
| --- | --- | --- |
| Link in running text | gold, no underline | ink + 1px underline at .35 alpha, full ink on hover (`.ah-prose-a`) |
| Active sidebar row | gold wash + gold type | **solid ink fill**, paper-coloured type |
| Filled circular arrow | gold fill | ink fill |

`--ah-band` is the secondary surface (newsletter panels, code, the announcement bar) — `#f1f2f5` light, `#0e0e0d` dark. It is not `--page-background`, which is the void outside the shell.

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

- **Sans (default):** DM Sans, loaded via `next/font/google` in `src/app/layout.tsx`.
- **Mono:** JetBrains Mono. Reserved for labels, commands, durations, counts, prices, badges and code — mono marks a *category*, and nothing outside that category uses it.
- Both are exposed on `<body>` as `--font-geist` / `--font-geist-mono`. The variable names are historical (they used to hold Geist); the families behind them are what the redesign changed. Components keep using `font-sans` / `font-mono`.

### 11. Type scale

**Compose `TYPE` from `src/components/landing/type.ts`. Do not write size classes inline.**

The landing components between them once used nine Tailwind size steps plus
arbitrary `text-[10px]` / `text-[11px]` values, five weights, and a scatter of
`leading-*` / `tracking-*` combinations picked per component. None of it was
wrong in isolation; together it meant two headings a screen apart could differ
by a step for no reason a reader could name.

Each constant carries its own leading and tracking, because those are part of
the size — a display line at `leading-relaxed` is not the same decision as one
at `leading-[1.05]`, and letting callers mix them is how the scatter came back
last time.

The sizes are the redesign spec's, not invented here. Values are desktop; the
constants step down about a third on mobile themselves, so callers never write a
breakpoint.

| Role | Constant | Desktop | Used for |
|------|----------|---------|----------|
| Display | `TYPE.display` | 76px | The home hero `h1`. Nothing else. |
| Display, landing | `TYPE.displayLanding` | 64px | A single-offer landing page's `h1` (`/skills/subscribe`). |
| Title | `TYPE.title` | 52px | Page `h1`s. |
| Article | `TYPE.article` | 44px | Article and lesson `h1`s. |
| Section, lead | `TYPE.section` | 44px | The home page's load-bearing section heads. |
| Section, offer | `TYPE.sectionOffer` | 42px | The cohort — the page's one paid thing. |
| Section, claim | `TYPE.sectionClaim` | 40px | The manifesto's argument. |
| Section, byline | `TYPE.sectionByline` | 38px | "Hi, I'm Matt Pocock". |
| Section, quiet | `TYPE.sectionQuiet` | 36px | Supporting sections: the posts grid. |
| Heading | `TYPE.heading` | 34px | The generic section `h2`, everywhere off the home page. |
| Rung question | `TYPE.rungQuestion` | 25px | The ladder's questions. |
| Panel title | `TYPE.panelTitle` | 24px | Titles inside a bordered panel. |
| Subhead | `TYPE.subhead` | 20px | `h3`s, card and row titles. |
| Quote | `TYPE.quote` | 20px | Pull quotes and testimonials (700, italic). |
| Card title | `TYPE.cardTitle` | 16px | Dense row and cell titles. |
| Lead, hero | `TYPE.leadHero` | 21px | The home hero's lead only. |
| Lead | `TYPE.lead` | 18.5px | The paragraph under an `h1` / `h2`. |
| Body | `TYPE.body` / `TYPE.bodyTight` | 17.5px | Prose, list rows. |
| Meta | `TYPE.meta` / `TYPE.metaProse` | 14px | Captions, buttons, inline links. |
| Meta, small | `TYPE.metaSm` | 13px | Attributions, footer utility links. |

**The five section steps are deliberate, and they are the one place this scale
is not minimal.** The prototype sizes each section head by how much of the
page's argument that section carries, and collapsing them to a single step —
which an earlier pass did — makes the whole page read flatter than the mock.
Off the home page, `TYPE.heading` is still the only section size.

Plus the mono constants, because mono is a category rather than a size:
`TYPE.command` (slash commands), `TYPE.metaMono` (13px data links), `TYPE.stat`
(26px numerals) — and the five that replaced `TYPE.micro`.

**`TYPE.micro` is gone, split five ways by what the mark attaches to.** It was
used 87 times across 46 files and read as texture. Raising its size (9.5 → 11px,
2026-07-29) made the texture *bigger*, because texture is a function of **count
and attachment**, not size. A mark floating above a heading, a kind marker on a
card, a label over a list, a caption under a numeral and a duration in a row are
five jobs; one constant made them one visual event repeated 87 times.

| Constant | Attaches to | Use for |
|---|---|---|
| `TYPE.eyebrow` | nothing — it floats | The rare framing mark above a heading. **Rationed.** |
| `TYPE.badge` | itself, via a `BADGE_*` container | Kind and status markers: `ARTICLE`, `Waitlist open`, `Free`. |
| `TYPE.groupLabel` | the list beneath it | Section labels, sidebar group heads, ToC and rail labels. No caps, no tracking — deliberate. |
| `TYPE.statLabel` | the numeral **above** it | Stat captions. Always renders below its value. |
| `TYPE.metaMark` | its card or row | Durations, counts, dates, bylines. |

A bare `TYPE.badge` is always a mistake: it carries no surface, so pair it with
`BADGE_SOLID`, `BADGE_NEUTRAL` or `BADGE_OUTLINE` from the same file.

`TYPE.metaMark` sits alongside `TYPE.command`, which is also 12px mono. They
differ in weight and that is the point: `command` is `font-medium` because a
slash command is a thing you type; `metaMark` is `font-normal` because a
duration is a thing you read. Do not merge them.

**Eyebrows are rationed, by judgement rather than by a counter.** An eyebrow
earns its place when it carries a fact the heading can't hold, that isn't a
property of a thing already on screen, and it is alone on the screen. Three
gates, applied in order:

1. **Fact test.** Cover it and read the heading. Did you lose a *fact* — a kind,
   a scope, a date, a sequence position, a status? Not a mood, not "a sense of
   section". If no fact is lost: delete it, and do not relocate it.
2. **Relocation test.** The fact survived; now house it elsewhere. Property of a
   thing → `badge`. Belongs in the sentence → fold it into the heading or lead.
   Names a number or a list → `statLabel` / `groupLabel`. The eyebrow is the
   last resort, never the first reach.
3. **Solitude test.** Is it the only eyebrow in its viewport, and one of at most
   two on the route? Two sections both wanting framing is a structure problem,
   not a labeling problem: pick the one that frames the whole page.

Survivors get MORE ink, not less (`text-foreground/70`, up from micro's ~45%). A
rare mark that still whispers fails as text while occupying the slot. `mb-3`
ships inside the constant — call sites choosing their own gap was half of why
the heading relationship read as loose.

**Weights.** Headings are **700**. The spec has no medium-weight heading: at
these tracking values a 500 display line reads as a different typeface rather
than as restraint. `font-medium` belongs to UI text and mono numerals,
`font-normal` to prose and to `lead`, which sits under a display line and has
to yield to it. `font-light` is gone — at these sizes on a dark background it
reads as a rendering fault rather than as a choice.

**Two families, two accents.** DM Sans and JetBrains Mono (rule 10). Mono
marks a category: labels, commands, durations, counts, stats. Uppercase appears
in three of the five mono label steps — `eyebrow`, `badge` and `statLabel` —
and pointedly not in `groupLabel` or `metaMark`, which sit next to running text.
Italic appears in one place: pull quotes.

Exempt, because they are ornaments rather than text: the oversized quotation
glyph in `TestimonialDivider` and the placeholder word in an empty
`ResourceCard` image slot. Both are drawings that happen to be made of letters.

Other typography rules:

- **Body measure:** cap reading columns at 65 to 75ch.
- **`text-balance` on headings and blockquotes that wrap.**
- Never let headings render with default Tailwind tracking. They look loose and generic.

---

## Shape, motion, interactivity

### 12. Five radii, and edges stay sharp

**Updated 2026-07-28, superseding the sharp-plus-pill rule.** The redesign
spec defines five radius steps, and pills are not one of them. A `rounded-full`
button was a house style; these values are the design's.

| Step | Value | Utility | Used for |
|------|-------|---------|----------|
| Badge | 4px | `rounded-[4px]` | Uppercase mono badges — "New", "Free", "Waitlist open". Use a `BADGE_*` container from `type.ts`. |
| Chip | 6px | `rounded-sm` | Command chips, tag pills, 28px icon buttons. |
| Control | 9px | `rounded-[9px]` | Buttons, CTA links, inputs. Also `--radius`. |
| Card | 11px | `rounded-md` | List cards and resource rows that float. |
| Panel | 12px | `rounded-lg` | Panels, hairline grid containers, image slots. |

**Edges are still sharp.** Anything meeting the container's `border-x` — full
bleed sections, hairline grid cells, rows that span the shell — takes no
radius. A radius belongs to something that reads as an object sitting *on* the
page, not to the page's own structure. If you are unsure, it is sharp.

`rounded-full` survives in exactly three places, all of them genuinely
circular: avatars, dots and bullets, and circular icon-only glyph buttons (the
video play button, `AnimatedArrowCircle`).

Two things that bite:

- A decorative overlay on a button (a shine sweep, a gradient) needs
  `rounded-[inherit]`, or its square corners spill past the curve. See the
  submit button in `convertkit-subscribe-form.tsx`.
- Not every surface is migrated. The shared `Button` hardcodes `rounded-none`,
  which callers override. Not-yet-converted, not a counter-example.

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

### 19. Mobile: one breakpoint, and the patterns that don't just stack

The redesign draws exactly ONE line, at **900px** — `desk:` (`--breakpoint-desk`). Use it for structural switches: a layout that changes shape rather than a size that changes value. It is deliberately not `md` (768px), because every pattern that has to change breaks between 768 and 900, and a tablet in portrait would otherwise get a desktop structure that does not fit. The existing `sm`/`md`/`lg` utilities are untouched; `desk:` names the one line the spec actually draws.

Six cases need a decision rather than a stack (`AI Hero Courses Redesign/Mobile Patterns.dc.html`). What is built so far:

| Pattern | Rule | Where |
| --- | --- | --- |
| Primary action | The page's one primary action pins to the bottom, with safe-area padding | `SkillStickyAction`, `.has-sticky-action` |
| Sidebar | Full-height sheet from the LEFT, never a dropdown — the hub tree is too tall for a popover. Body scroll locks; the drawer keeps its own scroll and opens on the current item; only the active branch is expanded | `MobileMenuPanel`, `useBodyScrollLock` |
| Rows | 44px minimum tap height | `rowClass` in the same file |
| Inline forms | Wrap to full-width fields. **Fields 48px, submit 50px** — the one deliberate size increase, because 44px is a fine pointer target and a poor thumb target | `SubscribeToConvertkitForm` and its callers |

**The one documented exception: the three-column article shell.** `desk:` is the line between a phone layout and a desktop one, and it holds for everything that is one column becoming two. The `[post]` shell is one column becoming *three* — 264px sidebar + 232px ToC rail is 496px of chrome — so a single line cannot serve it: at 900px it would leave a 360px measure, and the case that actually broke was a window at half of a 1080p screen (960px), which is above `desk:` and still far too narrow. The two side columns therefore retire one at a time, and neither is `desk:`:

| Width | Layout | Where |
| --- | --- | --- |
| `xl:` (1280+) | sidebar + prose + ToC rail | `PostToCRail`, the grid in `[post]/page.tsx` |
| `lg:` (1024–1279) | sidebar + prose; ToC folds into `PostToCDisclosure` under the head, share moves to its own row | same files |
| below `lg:` | prose only; the tree becomes the left drawer | `HubSidebarShell`, `MobileMenuPanel` |

The rail goes first because the tree is the more load-bearing of the two. `lg:` is not a new line: `MobileMenuPanel` and the hamburger were already there, and the sidebar sitting at `md:` meant every width from 768 to 1024 rendered the desktop sidebar and the drawer trigger for the same tree at once. Anything that stands in for the sidebar on small screens (`ListResourceNavigation`'s bottom bar) hides at `lg:` with it; anything standing in for the rail (the ToC disclosure, the mobile share row) hides at `xl:`.

A `fixed` bottom bar cannot be cleared by a spacer the page renders: the footer comes from `HubLayout`, above the page in the tree, so the spacer lands before it. Pad the document (`.has-sticky-action`) instead.

Still unbuilt, and listed here so nobody assumes they are done: the comparison table's one-block-per-row form, the 3-up stat row becoming a 2-col hairline grid, the logo wall dropping to two-per-row/eight marks, the phase list rotating to a horizontal scroller, and prose stepping back to 16.5px.

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

- **Side-stripe borders.** A colored `border-l` or `border-r` thicker than 1px as a card or alert accent. One exception, and only one: a **pull quote in running prose** may take a 2px `border-primary` left rail — `Testimonial` in `page-builder-mdx-components.tsx`, and `.ah-prose-quote` in `globals.css`, which is the raw markdown blockquote. There the rail is the quotation mark — the block has no surface of its own and the serif alone does not mark the change of speaker inside a column of sans. It stays banned anywhere the element already has a background, and at any width above 2px.
- **Gradient text.** `background-clip: text` on a gradient is decorative, never meaningful. Use weight or size, or `text-primary` if dark mode.
- **Glassmorphism as default.** Blurred translucent cards used decoratively. Rare and purposeful, or nothing.
- **Hero-metric template.** Big number, small label, supporting stats, gradient accent. SaaS cliché.
- **Identical card grids.** Same-sized cards with icon + heading + text repeated endlessly. The landing already varies between row and card variants on purpose.
- **Modal as first thought.** Exhaust inline and progressive alternatives first.
- **Pure `#000` or `#fff`.** Tokens are tinted neutrals. Stay there.
- **Em dashes in copy.** Use commas, periods, colons, semicolons, or parentheses.
- **Rounded page structure.** A radius on a section, a hairline grid cell, or any row that meets the container's `border-x`. Objects on the page get a radius; the page's own structure does not. See rule 12.
- **Radii off the scale.** Four steps plus 4px badges (rule 12). `rounded-full` on anything that is not a circle.
- **Bouncy / springy motion.** See rule 14.

---

## Quick checklist before opening a UI PR

- [ ] No `px-*` / `mx-*` on section wrappers that sit directly in the container
- [ ] Grid hairlines come from `bg-border` + `gap-px`, not per-cell borders
- [ ] Spacing values match the table in rule 3
- [ ] Two-column grids use the documented ratios in rule 4
- [ ] Colors come from shadcn tokens; documented exceptions only (rule 9)
- [ ] Sizes come from `TYPE` (rule 11); headings at 700; mono only for labels, commands, durations, counts and stats
- [ ] Mono labels use the right one of the five (rule 11): a mark above a heading is an `eyebrow` and is rationed; everything else is a `badge`, `groupLabel`, `statLabel` or `metaMark`
- [ ] Body columns capped at the spec's 70ch measure
- [ ] Radius follows rule 12: sharp page structure, 4 / 6 / 9 / 11 / 12 on objects, `rounded-full` only on circles
- [ ] Gold fills use `bg-accent-fill`, accent type uses `text-primary` (rule 7)
- [ ] Empty image slots use `bg-stripes`
- [ ] Motion uses ease-out-quart by default; reduced-motion guarded
- [ ] Focus-visible rings present on every interactive element
- [ ] Verified in both light and dark mode
- [ ] No banned patterns (see Bans section)
