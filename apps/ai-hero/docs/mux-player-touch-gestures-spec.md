# YouTube-style touch controls for the Mux player

Status: draft for review · 2026-08-20
Driver: learner feedback in Matt's Discord (AndrewElans, 2026-08-19): *"could they please consider adding play/stop and 10 sec back forward on the main screen while video is playing? sort of youtube style. buttons on the bar are very small on ipad/phone which makes it difficult to navigate."*

## Why this is a real gap, precisely

We ship stock Mux Player (`@mux/mux-player@3.13.0`, gerwig theme, media-chrome 4.19.1). On touch devices today:

- **Tap on the video only toggles control visibility.** Touch tap-to-play/pause is literally an empty method in media-chrome (`media-gesture-receiver.ts` — `handleTap` is an abstract no-op with a source comment deferring double-tap support). Play/pause requires hitting the small bottom-bar button.
- **No double-tap seek exists** anywhere in media-chrome or any Mux theme, including the `@player.style/yt` "YouTube theme" (visual clone only, zero gesture code). Confirmed against source and the issue tracker (muxinc/elements#703 closed unfixed).
- **On phones (<470px)** gerwig hides the bottom play, seek ±10s, and time-display buttons entirely — so a phone user has a centered play button but *no 10s seek affordance at all*.
- **On iPads (≥470px)** gerwig shows the desktop layout: everything crammed into the small bottom bar, no centered controls. This is exactly Andrew's complaint on both device classes.

So the feedback isn't a preference — the two things learners reach for most while following along with code (pause; jump back 10s) are genuinely hard on touch.

## YouTube feature inventory, ranked

Researched across YouTube desktop web, mobile web, and the native apps (the native app is what "youtube style" means to users). Ranked by expected learner benefit for **course video** (long-form, code-along, frequent pause/rewind) crossed with build cost. Status legend: ✅ already works in our player · 🔧 config/CSS only · 🛠 custom build.

### P1 — launch set (directly answers the feedback)

| # | Feature | YouTube behavior | Ours today | Verdict |
|---|---|---|---|---|
| 1 | **Touch-sized play/pause, bottom-left** | YouTube mobile-web keeps the video clean: big play button in the bottom bar, no floating overlay | Phone: small centered play. iPad: tiny bar button | 🔧 re-enable gerwig's bottom play button (hidden <470px) via a `::part(controller)` var override + touch sizing. *Decision note: a floating center cluster was built first and rejected in live testing — it covered the screencast content. No on-video seek buttons either; double-tap corners is the expected idiom.* |
| 2 | **Double-tap left/right → ±10s seek** | Works even while controls are hidden; renders only a ripple + "10 seconds" label; consecutive taps accumulate (10→20→30); center dead zone | Nothing | 🛠 custom gesture layer (the marquee gesture) |
| 3 | **Bigger touch targets for remaining chrome** | n/a (YouTube's are big by default) | media-chrome defaults sized for mouse | 🔧 CSS vars under `@media (pointer: coarse)`: `--media-control-height`, `--media-button-icon-width/height`, `--media-range-thumb-width/height`, `--media-range-track-height` |
| 4 | **Tap to reveal/hide + auto-hide** | Tap shows chrome, ~3s auto-hide, never hides while paused | ✅ built-in (media-chrome, `autohide` default 2s, pause-guard included) | keep; our overlay syncs via the `userinactivechange` event |

### P2 — fast-follow (cheap, same machinery)

| # | Feature | Notes |
|---|---|---|
| 5 | **Long-press → 2x while held** ("2x ▶▶" pill) | Same pointer state machine, ~500ms hold; restore rate on release |
| 6 | **Gestures survive fullscreen** on iPad / Android / desktop | `fullscreen-element="<wrapper-id>"` attr (documented Mux API): fullscreen requests target our wrapper div, so the overlay stays alive. iPhone is excluded by platform (see risks) |
| 7 | **Adopt on MDX-embedded players** (`TrackedMuxPlayer` / `mdx-video`) | Same wrapper, marketing surfaces |

### P2b — desktop polish (rides on the same shell machinery)

Desktop's baseline is already close to YouTube: single-click play/pause works (media-chrome handles mouse; only touch is a no-op), hover storyboard previews exist, and the full hotkey set (space/`k`, `j`/`l`, arrows, `f`, `m`, `c`) is built in. The gap is feedback and power-user gestures:

| # | Feature | YouTube behavior | Path |
|---|---|---|---|
| 8 | **Keyboard feedback HUD** | `j`/`l`/arrows flash a center ±10s glyph; volume changes flash a percentage | 🛠 the same `SeekFeedback` component listens to `seeked`/`ratechange`/`volumechange` and flashes the HUD for keyboard-initiated actions — near-zero extra code, makes the existing (currently silent) shortcuts feel discovered |
| 9 | **Double-click → fullscreen** | Desktop staple; absent from media-chrome (unimplemented discussion #1032) | 🛠 mouse branch of the existing single/double disambiguation, action = `requestFullscreen` on the wrapper |
| 10 | **Click-and-hold → 2x while held** | Shipped on YouTube desktop 2023, same as mobile long-press | 🛠 the P2 long-press machinery with a pointer-type check |
| 11 | **Chapter navigation keys** (Ctrl/⌥ + arrows) | Previous/next chapter | 🛠 small keydown handler reading the chapters track — course-specific gold: "jump to the next section of the lesson" beats any percent-jump for structured content (`addChapters` is already wired) |
| 12 | **`<` / `>` speed stepping** with a "1.5x" toast | ±0.25x per press | 🛠 keydown + the same toast/pill component as the 2x hold; much faster than the menu for the speed-riding cohort |

### P3 — deliberately skipped (documented so we don't re-litigate)

- **Slide-to-seek / precise-scrub filmstrip** — heavy; the enlarged seek bar already scrubs with storyboard previews (built-in).
- **Pinch zoom-to-fill, swipe up/down for fullscreen/miniplayer** — conflict with page scroll; native-app niceties.
- **Miniplayer** — separate product decision, not a gesture-layer concern.
- **`0–9` percent jumps** — YouTube parity, but chapter keys (#11) beat percent-jumps for structured lessons.
- **Theater mode (`t`)** — effectively already available: the sidebar collapse button widens the player. Revisit only if learners ask for a keyboard path to it.
- **Keyboard shortcuts** — ✅ already at YouTube parity for what matters: space/`k`, `j`/`l` ±10s, arrows, `f`, `m`, `c` (media-chrome built-in; our seek offset is already 10s). What's missing is *feedback*, covered by #8.
- **Speed menu, chapters, captions, storyboard hover previews, autoplay-next** — ✅ all already present (binge mode covers autoplay-next).

### The interaction model (decided 2026-08-20)

YouTube ships two different touch models: the native app's "single tap only reveals chrome, play/pause needs the center button" and desktop web's "single click/tap toggles playback directly". **Vojta picked the desktop-web model for touch**: single tap pauses/resumes (after the 250ms double-tap disambiguation window), pausing shows the chrome (which stays while paused), and resuming re-arms the ~3s auto-hide. Double-tap on the side thirds still seeks without pausing. Every play/pause transition flashes a YouTube-style center glyph (scales up and fades, ~0.5s) as confirmation. Chrome hide timing: ~1s after playback starts, ~3s after other interactions. Desktop mouse behavior (single click = play/pause, built-in) stays untouched.

## Solution design

### Architecture: sibling overlay in a fullscreen-capable wrapper

One new shared component, no changes to Mux internals, no custom theme, no shadow-DOM poking:

```tsx
// apps/ai-hero/src/components/player/player-gesture-shell.tsx
<PlayerGestureShell playerRef={playerRef} className="aspect-video …">
  <MuxPlayer fullscreen-element={shellId} … />
</PlayerGestureShell>
```

Renders:

```
<div id={shellId} class="relative …">        ← takes over the aspect/max-h caps
  {children}                                  ← the MuxPlayer, unchanged
  <GestureSurface />                           ← absolute inset-0, coarse-pointer only
  <PlayPauseFlash />                           ← center glyph on state change
  <SeekFeedback />                             ← ripple + "±NN seconds" label
  <SpeedPill />                                ← "2x ▶▶" while long-pressing
</div>
```

Why this shape (from the extensibility research):

- **mux-player has no chrome slots** (only `poster`; children land inside the `<video>`), and injecting into `player.mediaController` slots is undocumented and fragile across majors. A custom theme means forking gerwig's ~1400-line template. A React sibling overlay is the only option that's both supported and cheap.
- **Fullscreen**: the documented `fullscreen-element` attribute makes the built-in fullscreen button, the `f` hotkey, and programmatic fullscreen all target our wrapper — overlay included. Verified in `base.mjs`: it resolves the id and sets `mediaController.fullscreenElement`.
- **Driving the player**: the existing `MuxPlayerRefAttributes` ref gives `currentTime`, `play()`, `pause()`, `playbackRate`, and the `mediaController` getter. No new context needed — the ref is passed as a prop, so this works identically in `AuthedVideoPlayer` and `PostPlayer`.

### Visibility sync and event ownership

- media-chrome dispatches **`userinactivechange`** (composed, bubbles — crosses the shadow boundary), so `playerEl.addEventListener('userinactivechange', …)` drives our `controlsVisible` state. Also listen to `play`/`pause`/`ratechange` for icon/pill state.
- **Pointer-events choreography** (this is the crux — the overlay must never block the real controls):
  - Controls **hidden** → `GestureSurface` is `pointer-events: auto` and owns all taps: single tap reveals chrome (set `mediaController.userInactive = false`), double-tap seeks, long-press speeds. media-container never sees these taps, which is fine — we re-implement the one behavior it owned.
  - Controls **visible** → `GestureSurface` goes `pointer-events: none`; native chrome buttons work untouched, and media-container's own tap-on-video-to-hide keeps working. Only the `CenterCluster` buttons stay interactive (they're real `<button>`s with `aria-label`s).
  - The touch tap/double-tap surface is gated to `matchMedia('(pointer: coarse)')` — mouse single-click play/pause (built-in) stays untouched. The shell itself mounts on all pointers once P2b lands: on fine pointers it only handles double-click fullscreen, hold-for-2x, the keyboard HUD, and the extra keydown shortcuts.
- Surface CSS: `touch-action: manipulation` (kills double-tap zoom + 300ms delay, keeps page scroll), `user-select: none`, `-webkit-touch-callout: none`.
- Z-order: shell children sit above the player but below the lesson overlay system (`z-40`) — pricing/completed/soft-block overlays keep covering everything, so gestures are automatically inert when an overlay is up.

### Gesture state machine (pure + unit-testable)

Small reducer, no DOM: input events `{pointerdown, pointerup, move, timerExpired}` with `x`-zone (left 0–35% / center / right 65–100%) and timestamps → actions.

- **Single tap**: 250ms disambiguation timer → toggle play/pause (see the interaction-model decision above).
- **Double tap in a side zone**: cancels the timer → `SEEK(±10)`, enters accumulate mode (~650ms rolling window) where each further tap on the same side adds ±10 and the label counts up "20 seconds", "30 seconds". Chrome stays hidden (YouTube parity).
- **Double tap in the center dead zone**: treated as single tap.
- **Long-press ≥500ms** (P2): `SPEED_HOLD_START` → set `playbackRate = 2` (stash prior rate); `pointerup` → restore. Known harmless quirk: `onRateChange` will transiently persist 2x to the prefs cookie and then persist the restored rate — net state correct.
- **Pointer moved >10px or multi-touch**: cancel everything (it's a scroll/pinch).
- Seeks clamp to `[0, duration]` and go through `currentTime` assignment, so the existing throttled `persistPlaybackPosition` pipeline is untouched.

### Feedback UI

- Ripple: semicircular flash anchored to the tapped edge + `▶▶▶` glyphs + "NN seconds" label; framer-motion (already a dependency, v12) with the app's existing `useReducedMotion` precedent — reduced motion gets the label without the ripple scale.
- Center cluster: three buttons, ~48px icons in ≥64px hit areas on a `bg-black/60` scrim circle, fading in/out with `controlsVisible` on the same timing as the chrome.
- Redundant defaults hidden via documented vars while the cluster is active, e.g. `--center-play-button: none` on coarse pointers (phones currently show gerwig's small centered play).

### Analytics

`track('video_gesture', { gesture: 'double_tap_seek' | 'center_cluster' | 'long_press_speed', direction?, seconds? })` through the existing `track()` util, debounced per accumulate-burst — so we can tell Andrew (and ourselves) whether it's used.

## Rollout

All learner-facing video reduces to two integration points, both of which already hold the typed ref:

1. `AuthedVideoPlayer` (`src/app/(content)/_components/authed-video-player.tsx`) — every workshop + cohort lesson (cohorts route through `/workshops/[module]/[lesson]`). Needs the new wrapper (the player currently renders with no wrapper element; the shell takes over the `aspect-video … md:max-h-[75svh] md:max-w-[calc(75svh*16/9)]` caps from `shared-page.tsx`).
2. `PostPlayer` (`src/app/(content)/posts/_components/post-player.tsx`) — free posts, skills pages, changelogs (`[post]` and `skills/[slug]` routes both render it).

Out of scope at launch: hero video (muted, `pointer-events-none`, decorative), `team-video` (marketing, own overlay), CMS preview players. MDX embeds are the P2 adoption.

### PR sequence (LAUNCH MODE aware — campaign live until Aug 25)

- **PR 1 — low-risk, ship now**: coarse-pointer CSS sizing enlargement (#3) + the transcript-ref fix (`.brain/tasks/lesson-player-ref-and-playsinline-fixes.svx`). Pure CSS vars + un-commenting one wiring line; helps the current cohort immediately.
- **PR 2 — gesture shell**: center cluster (#1) + double-tap seek (#2) + `fullscreen-element` wrapper (#6, it's free once the wrapper exists). Gated on the device QA checklist below, not on the calendar — the feedback is from the live cohort, so if QA is green before Aug 24 we ship; anything flaky waits until after launch week. Preview URL via vojta.ngrok.app for Matt per the usual triage flow.
- **PR 3 — fast-follow**: long-press 2x (#5), MDX embed adoption (#7), desktop polish (#8–#12 — the HUD, double-click fullscreen, and hold-for-2x fall out of the shell almost for free; chapter keys and speed stepping are small keydown additions).

## Verification

- **Unit (vitest)**: the gesture reducer — single/double/accumulate sequences, dead zone, cancel-on-move, timer edges.
- **Device QA checklist**:
  - iPhone Safari: gestures inline; entering fullscreen hands off to the **native iOS player** (no custom UI possible there — `requestFullscreen` is still flag-disabled on iPhone; identical to YouTube web's behavior; `playsinline` is hardcoded by mux-player so inline is the default). Confirm no double-tap-zoom, page scroll over video still works.
  - iPad Safari: center cluster + double-tap in both inline and fullscreen (wrapper fullscreen works on iPad).
  - Android Chrome: same, plus fullscreen rotation.
  - Desktop: mouse click still toggles play/pause, hotkeys unchanged, no overlay hit-testing (fine pointer → layer inert).
  - Captions/settings menus still reachable; chrome auto-hide + pause-guard unchanged; reduced-motion mode.
  - Lesson overlays (completed/pricing/soft-block) still cover and block the gesture layer.

## Open questions

1. `autohide` 2s (media-chrome default) vs ~3s (YouTube feel) — one attribute; propose 3s with the cluster since bigger targets need a beat longer.
2. Center dead-zone width — start at 30% (Vidstack uses side-30% regions), tune on device.
3. ~~Centered play button~~ — resolved: hidden on coarse pointers; play/pause lives bottom-left like YouTube mobile web.

## Verified facts this spec rests on

- Touch tap-to-play/pause and double-tap seek are absent by design in media-chrome 4.19 (empty `handleTap`, source TODO); tap-toggle-chrome lives in `media-container.ts` and can't be disabled alone.
- `fullscreen-element` attribute is documented and wired in `base.mjs` (sets `mediaController.fullscreenElement`).
- `userinactivechange` is composed+bubbling → observable from React on the player element.
- `playsinline` is hardcoded on the internal `<mux-video>` — do not add the prop.
- Seek offsets already default to 10s (buttons + keyboard); `j`/`l` hotkeys already work.
- gerwig hides bottom play/seek/time controls below 470px (`breakpoints="sm:470"` hardcoded).
- No gesture code or gesture library exists in the app today; framer-motion v12 is available for the feedback UI.
