# Workshop Landing Page — Sidebar & Actions Bar Specification

A handoff spec for redesigning the two most dynamic regions of the workshop
landing page (`/workshops/[module]`): the **actions bar** (the full-width
button strip under the hero) and the **sidebar** (the right column). It
documents every state, where each state comes from, the behavioral contracts a
redesign must preserve, and the places the current implementation drifts from
the brand language.

> **Screenshots**: slots are marked `[SCREENSHOT: …]` throughout — they will be
> attached separately.

---

## 1. Scope and goal

**In scope**
- The actions bar: the `Links` strip rendered under the hero and repeated
  above the footer (`page.tsx`, local `Links` component).
- The sidebar: the right column of the 6-column content grid, in all its
  states (`workshop-sidebar.tsx` and everything it hosts).
- The mobile counterpart of the sidebar: the fixed bottom purchase/notify bar.

**Out of scope** (unless a change falls out naturally)
- Hero (title/description/cover image), article body, footer.
- The lesson page (`/workshops/[module]/[lesson]`) and its navigation sidebar.

**Goal**: redesign both regions to align with the current brand language
(section 2) without changing behavior. Every state listed in sections 4–6 must
still exist and be reachable; the redesign changes how they look, not what
they do.

---

## 2. Brand language — normative sources

Read these before proposing anything:

| Source | What it is |
| --- | --- |
| `AI Hero Courses Redesign/aihero.css` (repo root) | The token + pattern spec. Where it and a component disagree, **it wins**. |
| `apps/ai-hero/DESIGN.md` | The distilled rules (register, hairline weights, radii, type scale, color strategy). |
| `src/components/landing/type.ts` | `TYPE` scale — all text sizes come from here, never inline. |
| `src/app/page.tsx` + `src/components/landing/` | The canonical rendered reference. |

Key constraints that bear directly on these two regions:

- **Restrained + abstract accents.** Tinted neutrals carry 90%+ of every
  surface; gold is reserved for the one primary action per view. Gold fills
  are `bg-accent-fill` (survives both themes); accent *type* is
  `text-primary` (resolves to ink in light mode — DESIGN rule 7).
- **Three hairline weights** — `border-border` (section/grid), `border-input`
  (card outlines, inputs, chips), `--ah-line-soft` (dividers inside a list or
  card). Mixing them in one view is the most common drift.
- **Radii: 4 / 6 / 9 / 11 / 12.** Page structure stays sharp; `rounded-full`
  only on circles.
- **Container owns the side borders** (1440px shell, `border-x`); no
  horizontal padding on section wrappers — pad inner content (44px desktop
  gutter, 18px mobile).
- Light **and** dark mode both required.
- The established CTA object: `WORKSHOP_CTA_BUTTON` in
  `workshop-notify-button.tsx` — gold fill, 46px tall, 9px radius, 15px bold
  label. The waitlist card and mobile bar already use it; treat it as the
  brand-correct button reference.

---

## 3. Page anatomy

```
┌─ LayoutClient (1440px shell, border-x) ─────────────────────────────┐
│  [draft banner — pre-launch only, admin only]                       │
│  Hero: breadcrumb / h1 / description / contributor │ cover image    │
│  ═══ ACTIONS BAR (Links) ═══════════════════════════════ border-y   │
│  ┌ article (col-span-4) ──────────────┬ SIDEBAR (col-span-2) ─────┐ │
│  │ MDX body                           │ state machine, §5         │ │
│  │ [inline content list, some states] │ sticky, md:border-l       │ │
│  └────────────────────────────────────┴───────────────────────────┘ │
│  ═══ ACTIONS BAR again (border-b-0) — published workshops only ═══  │
└─────────────────────────────────────────────────────────────────────┘
```

- Grid: `md:grid grid-cols-6`; article `col-span-4`, sidebar `col-span-2`.
- Below `md` everything stacks; the sidebar's purchase/notify function moves
  into a fixed bottom bar (§6).

**Files**

| Region | File |
| --- | --- |
| Page assembly + `Links` bar | `src/app/(content)/workshops/[module]/page.tsx` |
| Sidebar shell (sticky, mobile bar) | `../_components/workshop-sidebar.tsx` |
| Action buttons | `../_components/workshop-user-actions.tsx` |
| Pricing state machine | `../_components/workshop-pricing-widget-container.tsx` |
| Pricing widget proper | `../_components/pricing-widget.tsx` |
| Waitlist / interest card | `../_components/workshop-interest-cta.tsx` |
| Notify CTA + `WORKSHOP_CTA_BUTTON` | `../_components/workshop-notify-button.tsx` |
| Content list | `../_components/workshop-resource-list.tsx` → `(content)/_components/resource-list-view.tsx` |
| Certificate tile | `(content)/_components/module-certificate-container.tsx` |

---

## 4. Actions bar (`Links`)

`[SCREENSHOT: actions bar — purchased state, gold "Continue Learning" with
diamond notch]`
`[SCREENSHOT: actions bar — pre-launch state, only "Share" visible]`

### 4.1 Structure

A full-width strip with `border-y`, 6-column grid mirroring the content grid
below it. Left 4 columns hold the buttons; the right 2 columns hold the
`Content` label (aligned over the sidebar, `border-l`, only when the workshop
has published content). A soft gradient hairline
(`via-foreground/10`) is painted along the bottom-right two-thirds.

Row composition, left to right:
1. **Stripes spacer** — `bg-stripes`, 40px wide (lg), `border-r`, decorative.
2. **`GetAccessButton`** — only when the viewer *cannot* view and the workshop
   belongs to a cohort product. Gold-ish (`bg-primary`) link to the cohort
   page. Label: "Get Access".
3. **`StartLearningWorkshopButton`** — the primary action (§4.2).
4. **`WorkshopGitHubRepoLink`** — ghost button, GitHub icon + "Code"; only
   when a repo URL exists *and* the viewer has access.
5. **Share** — ghost button, opens a share dialog. Always present.
6. **`ContentTitle`** — right 2 cols, "Content" label, only when
   `!isPreLaunch && hasContent`.

All buttons are 56px tall (`h-14`), square-cornered (`rounded-none`),
separated by `border-r` hairlines. On mobile the row wraps and dividers
switch to `divide-y`.

The strip renders **twice**: under the hero, and again above the footer
(`border-b-0`, published workshops with a body only).

### 4.2 `StartLearningWorkshopButton` states

Resolved from an ability loader (`getAbilityForResource`) + module progress
(`useModuleProgress`) + navigation:

| State | Condition | Rendering |
| --- | --- | --- |
| **Start Learning** | can view, no progress | Gold solid button → first lesson |
| **Continue Learning** | can view, ≥1 completed lesson | Same object → `moduleProgress.nextResource` |
| **Loading…** | progress not yet resolved | Same object, "Loading..." label |
| **Available {date} (PT)** | purchased but `isPendingOpenAccess` with `startsAt` | Disabled, transparent, `cursor-not-allowed`, date formatted in PT |
| **Hidden** | cohort product (`productType === 'cohort'`), or cannot view, or no first lesson resolvable | `null` |
| **Skeleton** | Suspense fallback | "Checking your access…" + spinner, transparent |

**Signature visual quirk**: the button carries a rotated-square "diamond
notch" pinned to its left edge (`before:` 8px square rotated 45°, painted
`bg-primary-foreground`) — visible in the screenshot as the notch between the
stripes spacer and the gold fill. This motif appears on Start/Continue,
Get Access, pending-open-access, and the skeleton. A redesign should decide
deliberately whether this motif survives; it exists nowhere else in the brand
language.

### 4.3 Known drift / redesign notes

- The bar's buttons are ad-hoc: `h-14`, varying `max-w-[120–300px]` caps,
  `rounded-none` — none of it comes from `TYPE` or the CTA reference object.
- The gold here is `Button` default (`bg-primary`) — in light mode that is
  *ink*, not gold (DESIGN rule 7); the correct fill for a primary action is
  `bg-accent-fill`.
- Two visually different "primary" buttons can appear side by side
  (Get Access + Preview variants).
- The `Content` label only aligns with the sidebar at `md+`; below that it
  vanishes silently.

### 4.4 Behavioral contracts (must survive redesign)

- Ability resolution is async — a Suspense fallback state **must** exist.
- Start/Continue target URLs come from module progress; don't collapse the
  two labels.
- Pending-open-access must render as visibly disabled, with the PT date.
- The strip is duplicated top and bottom; whatever replaces it must work in
  both slots.

---

## 5. Sidebar (desktop)

`[SCREENSHOT: sidebar — waitlist state, hatched ground + "Be first in line"
card]`
`[SCREENSHOT: sidebar — purchased state, content list]`
`[SCREENSHOT: sidebar — buy state, pricing card]`

### 5.1 Shell mechanics (`workshop-sidebar.tsx`)

- Column: `col-span-2`, `md:border-l`, `bg-background`, `z-20`.
- Inner shell is `md:sticky top-(--nav-height)`, capped by a `ScrollArea` at
  `lg:max-h-[calc(100vh - nav-height)]` so a tall pricing card always sticks
  and scrolls internally. (Note: the site nav is sticky on this page, so the
  `top-(--nav-height)` offset is correct here — unlike lesson pages.)
- `id="buy"` on the shell — the in-body `EnrollNow` MDX component and the
  mobile bar scroll-to-target this anchor. **Must be preserved.**
- The shell has **no padding by design**: pricing card and resource list fill
  the column edge-to-edge. The waitlist state is the exception — it gets
  `p-5 sm:p-6` inset *from the shell* (the card is an object sitting on a
  ground) plus `empty:hidden` so the inset collapses when the card removes
  itself.
- Waitlist state (and only that state) paints the whole column with the
  hatched ground: `bg-muted bg-stripes-muted` + `lg:border-l` — same
  treatment as the skills-course signup column. It intentionally runs the full
  column height.
- Buy/waitlist states pull the column up over the actions bar with
  `md:-mt-14` so the card top aligns with the strip. This is why the actions
  bar appears "notched" on the right in those states.
- A bottom fade (`from-background` gradient, 80px) is painted when the
  sidebar content is taller than the viewport, as a scroll affordance.

### 5.2 State machine

Decided in `page.tsx` from: workshop `state` (`published` or not), product
existence and type (`self-paced` / `cohort` / none), pricing props
(`allowPurchase`, `hasPurchasedCurrentProduct`):

```
isPreLaunch = workshop.state !== 'published'
shouldShowPricingSidebar = product.type === 'self-paced' || isPreLaunch

A. Buy state          allowPurchase && !hasPurchased          → pricing card (§5.3), bg-card, -mt-14
B. Waitlist state     isPreLaunch && !allowPurchase
                      && !hasPurchased                        → interest card (§5.4) on hatched ground, -mt-14
C. Purchased state    hasPurchased (self-paced)               → content list + certificate tile (§5.5)
D. No product         cohort workshop or no product           → content list only (no -mt-14)
```

Suspense fallback while pricing resolves: four stacked `bg-accent` skeleton
bars, `-mt-14`.

Additionally, **state A duplicates the content list into the article column**
("Content" heading + flat list under the body) so buyers can still scan the
curriculum while the sidebar is occupied by pricing.

### 5.3 Buy state — pricing card internals

`WorkshopPricingClient` → `WorkshopPricingWidgetContainer` →
`PricingWidget`. The container is itself a state machine, evaluated in PT:

| Enrollment state | Condition | Rendering |
| --- | --- | --- |
| **Open** | inside `openEnrollment`/`closeEnrollment` window (default open) or `allowPurchase` param | Full pricing widget |
| **Not open yet** | `openEnrollment` in future | "Enrollment opens {date}" + waitlist form |
| **Closed** | past `closeEnrollment` | "Enrollment is closed" + waitlist form |
| **Sold out** | limited seats, polled availability ≤ 0 (60s polling; coupon can `bypassSoldOut`) | "Sold Out" + waitlist form |
| **Hidden** | product unpublished/archived without `allowPurchase` | `null` |

The waitlist form inside not-open/closed/sold-out: one-click gold button for
an authenticated user (identity resolved server-side; falls back to the email
form if the session is stale), email form otherwise; success and
"check your inbox" confirmations; a skeleton bar while the session resolves.

Full pricing widget composition (top → bottom): product name · live seat
count (live events) · price (large, with strikethrough/discount when a coupon
or sale applies) · team toggle + quantity input (up to 100 seats) · **buy
button** · money-back guarantee badge · sale countdown (when a sale runs) ·
PPP toggle (regional pricing, boxed).

### 5.4 Waitlist state — interest card

The card (`workshop-interest-cta.tsx`) is already aligned with the brand
panel language (bordered card on `--ah-band`, neutral "Waitlist open" badge,
`panelTitle` ask, 44px controls at 9px radius, gold submit) — treat it as the
*reference* for where the rest should land, not as a redesign target.

Its states:
- **Unknown visitor**: email form (`ConversionIntentForm`) + "No spam" line.
- **Known subscriber / signed-in**: single one-click gold button; copy drops
  the "leave your email" phrasing.
- **Already interested** (prior visit): the card removes itself entirely
  (`null`) — the hatched column collapses via `empty:hidden`.
- **Just clicked** (`done`): stays visible with a check-circle confirmation.
- **Resolving**: two pulsing placeholder bars matching the form's footprint.

### 5.5 Purchased state

- The content list (`ResourceListView`, `withHeader={false}`, `h-auto`,
  non-collapsible): numbered section accordions with per-section progress
  (`0/9`), lesson rows with play/check icons, edit pencils for admins.
- Below it, in `p-3`: the **certificate tile** — locked look until
  `percentCompleted === 100`, then "Certificate of Completion / Get
  Certificate" opening a dialog (name input, download, share URL).

### 5.6 Behavioral contracts (must survive redesign)

- `id="buy"` anchor and smooth-scroll targeting.
- All four top-level states + the pricing container's internal states.
- Seat-availability polling and its live updates.
- The already-interested card removing itself (no empty husk).
- Sticky + internal scroll (the column must never trap page scroll).
- The `-mt-14` overlap is a *layout decision* a redesign may replace — but
  whatever replaces it must resolve the actions-bar/sidebar seam
  intentionally in states A and B.

---

## 6. Mobile bottom bar (`WorkshopSidebarMobile`)

`[SCREENSHOT: mobile bottom bar]`

- Fixed to the viewport bottom below `md`: `bg-background/90` + blur,
  `border-t`, workshop title + contributor on the left, action on the right.
- The action mirrors the sidebar state: **Get notified** (scrolls to `#buy`)
  in the waitlist state, otherwise an inline **buy button** with price.
- Fades out (`opacity-0`, non-interactive) while the real sidebar is in view
  (IntersectionObserver on the `#buy` shell) so it never doubles the CTA.
- Purchased/no-product states currently render the bar with no action —
  title + author only. A redesign may want to give those states a purpose
  (e.g. Continue Learning) or drop the bar; either is a product call to flag.

---

## 7. Known off-brand details (redesign opportunities)

Collected drift, beyond §4.3:

1. **The buy button** (`pricing-widget.tsx`) is the loudest violation:
   `bg-blue-600` (dark: `bg-primary`), `rounded-xl`, `shadow-xl`, 64px tall,
   an animated diagonal shine sweep. Blue exists nowhere in the palette;
   permanent motion on a static control conflicts with the restraint rules
   and with the precedent that killed the interest card's rainbow frame.
   The brand-correct object is `WORKSHOP_CTA_BUTTON` (gold fill, 46px, 9px
   radius).
2. **Radii are scattered** across the two regions: 0 (actions bar), 9px
   (waitlist controls), 12px+ (`rounded-xl` buy button), `rounded` (PPP box,
   certificate tile). The scale is 4/6/9/11/12.
3. **The diamond-notch motif** (§4.2) is unique to these buttons — keep it
   everywhere or nowhere.
4. **PPP toggle and sale countdown** are unstyled commerce-package defaults
   (`bg-muted` box, plain text) — they've never been through the redesign.
5. **Skeletons** use `bg-accent` in the sidebar fallback but `bg-muted`
   pulse bars in the waitlist card — one loading language should win.
6. Certificate tile typography (`text-primary` uppercase eyebrow, freehand
   sizes) predates the `TYPE` scale.

---

## 8. Launch context (until 2026-08-25)

The AI Coding Crash Course campaign is in flight: doors open **Aug 17**,
intro price **$199 until Aug 24**. The buy state with a sale countdown and
the waitlist→buy transition are therefore the states with live traffic;
redesign work must not degrade them mid-campaign, and shipping visual changes
to these surfaces before Aug 25 needs explicit sign-off.

---

## 9. What the design agent should deliver

1. A visual direction for the actions bar covering **all** §4.2 states.
2. A sidebar direction covering states A–D plus the pricing container's
   internal states (§5.3) — including light mode, which currently gets the
   least attention.
3. A decision on the shared seam: actions bar ↔ sidebar top (`-mt-14`
   overlap today).
4. Mobile bottom bar treatment for all states (§6).
5. Token/`TYPE`-based specs (no freehand sizes or colors) so the
   implementation maps 1:1 onto `aihero.css` + `DESIGN.md`.
6. **One switchable canvas per region, not per-state frames** — every state
   above reachable through the Tweaks panel. The exact control matrix and
   dependency rules are in `TWEAKS.md` (handoff package).
