# YouTube-style touch controls for the Mux player

Status: shipped in PR #134 (all P1 + P2 + P2b items, plus page-wide hotkeys and the autoplay toggle in the touch chrome) · 2026-08-20
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
| 1 | **Touch-sized play/pause** | Big centered button whenever chrome shows + bar button | Phone: small centered play. iPad: tiny bar button | 🛠 shell renders its own centered play/pause with the chrome (72px target) — gerwig's is template-gated to <470px so iPads never get it; bottom bar play also re-enabled via `::part(controller)` + touch sizing. *Decision trail: a 3-button center cluster was rejected (covered the screencast); no on-video seek buttons — double-tap corners is the idiom.* |
| 2 | **Double-tap left/right → seek** | Works even while controls are hidden; renders only a ripple + seconds label; consecutive taps accumulate; center dead zone | Nothing | 🛠 custom gesture layer (the marquee gesture). Shipped at **±5s** (YouTube's arrow-key step — our videos are short, 10s overshoots), matching `forwardSeekOffset`/`backwardSeekOffset` on all players. Both taps must land in the same zone: a cross-zone pair restarts as a fresh first tap instead of seeking. |
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
- **Keyboard shortcuts** — media-chrome ships the in-player set (space/`k`, `j`/`l`, arrows, `f`, `m`, `c`), but only with focus inside the player. We shipped **page-wide hotkeys** on top (document-level listener in the shell): arrows/`j`/`l` seek ±5s, `k` **and space** toggle play/pause, `m` mutes, `f` fullscreens — without player focus, YouTube-style. Guards: `defaultPrevented`, modifier keys, IME composition, editable/arrow-driven widget roles (`isTypingTarget` + `HOTKEY_EXEMPT_ROLES`), focus-inside-player (media-chrome handles it — no double-seeks), and space still activates focused buttons/links. Seek offset is set to 5s everywhere.
- **Speed menu, chapters, captions, storyboard hover previews, autoplay-next** — ✅ all already present (binge mode covers autoplay-next).

### The interaction model (final, 2026-08-20 — revised twice in live testing)

The YouTube-native model, converged on after first trying direct tap-to-pause: **a background tap while the chrome is hidden reveals it (bringing up a big centered play/pause button); a background tap while the chrome shows hides it again — playing or paused makes no difference; play/pause is the centered or bottom button.** Pre-play is the one exception: a tap starts playback instead of hiding the only affordance on screen. The reveal/dismiss symmetry is the accidental-tap protection. Hiding while paused requires two small constructed stylesheets appended into the (open) media-controller and theme shadow roots — media-chrome's own autohide CSS refuses to fade the chrome under `[mediapaused]` and gerwig keeps its backdrop; the injection is coarse-pointer-only, removable, and degrades to pinned-while-paused if a future bundle closes the roots. Details:

- Double-tap on the side thirds seeks ±5s without pausing (accumulating ripple); both taps must land in the same zone (a cross-zone pair restarts as a fresh first tap — sloppy input must never seek); a center tap during a seek burst ends the burst and acts as a fresh tap (a swallowed tap reads as a dead spot).
- A lingering press that never engaged 2x (e.g. while paused) acts as a tap on release — no dead taps.
- Tapping anywhere **off** the video instantly hides the chrome — playing or paused (pre-play excepted).
- The centered play/pause button is the shell's own (gerwig's is template-gated to <470px, so iPads could never render it); it doubles as the pre-play affordance. The state-change flash only fires when the button isn't visible — otherwise the icon flip is the feedback.
- Chrome hide timing: ~1s after playback starts, ~3s after other interactions. The idle auto-hide never runs while paused — paused chrome stays up until an explicit tap dismisses it. Fade transitions are media-chrome's (~0.25s).
- The **autoplay toggle** renders in the touch chrome's top-left (the shell's `chromeSlot` prop — gerwig's bar has no slots, so it's overlay composition, not shadow surgery), fading with the chrome; wired on lesson and post players.
- Desktop mouse behavior (single click = play/pause, built-in) stays untouched.

Implementation gotcha for posterity: the media-chrome bundle inside mux-player 3.13 has **no working `userInactive` property setter** — visibility must be driven by setting/removing the `userinactive` attribute directly.

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

```text
<div id={shellId} class="relative …">        ← takes over the aspect/max-h caps
  {children}                                  ← the MuxPlayer, unchanged
  <GestureSurface />                           ← absolute, coarse-pointer only
  <ChromeSlot />                               ← top-left, e.g. autoplay toggle
  <CenterPlayPause />                          ← the shell's 72px button
  <PlayPauseFlash />                           ← center glyph on state change
  <SeekFeedback />                             ← ripple + "±NN seconds" label
  <SpeedPill />                                ← "2x ▶▶" while long-pressing
</div>
```

Why this shape (from the extensibility research):

- **mux-player has no chrome slots** (only `poster`; children land inside the `<video>`), and injecting into `player.mediaController` slots is undocumented and fragile across majors. A custom theme means forking gerwig's ~1400-line template. A React sibling overlay is the only option that's both supported and cheap.
- **Fullscreen**: the documented `fullscreen-element` attribute makes the built-in fullscreen button, the `f` hotkey, and programmatic fullscreen all target our wrapper — overlay included. Verified in `base.mjs`: it resolves the id and sets `mediaController.fullscreenElement`.
- **Driving the player**: the existing `MuxPlayerRefAttributes` ref gives `currentTime`, `play()`, `pause()`, `playbackRate`, and the `mediaController` getter. The shell itself takes the ref as a prop, so it works identically in `AuthedVideoPlayer`, `PostPlayer`, and `MDXVideo`. Separately, lesson pages publish the same ref through the existing `MuxPlayerProvider` context (`setMuxPlayerRef` in `AuthedVideoPlayer`) — that's what transcript timestamp clicks seek through, and re-wiring it was the transcript fix shipped alongside (`.brain/tasks/lesson-player-ref-and-playsinline-fixes.svx`).

### Visibility sync and event ownership

- media-chrome dispatches **`userinactivechange`** (composed, bubbles — crosses the shadow boundary), so `playerEl.addEventListener('userinactivechange', …)` drives our `controlsVisible` state. Also listen to `play`/`pause`/`ratechange` for icon/pill state.
- **Pointer-events choreography** (this is the crux — the overlay must never block the real controls; shipped shape, revised in live testing):
  - Controls **hidden** → `GestureSurface` covers `inset-0` and owns all taps: single tap reveals chrome, double-tap seeks, long-press speeds. media-container never sees these taps, which is fine — we re-implement the one behavior it owned.
  - Controls **visible** → the surface stays mounted but shrinks to the strips the chrome doesn't occupy (`top-[min(48px,15%)] bottom-[min(88px,35%)]` — fixed-pixel insets left a dead sliver on short phone players), so double-tap seeks keep working with the chrome up while the bar, timeline, and the shell's centered button stay natively tappable. A single tap here hides the chrome (or resumes while paused). `setPointerCapture` on pointerdown — the geometry swap mid-gesture would otherwise lose the `pointerup` and swallow the next tap as a phantom pinch.
  - The touch surface is gated to `matchMedia('(pointer: coarse)')` — mouse single-click play/pause (built-in) stays untouched. The shell itself mounts on all pointers: on fine pointers it only handles double-click fullscreen, hold-for-2x, the keyboard HUD, and the extra keydown shortcuts.
- Surface CSS: `touch-action: manipulation` (kills double-tap zoom + 300ms delay, keeps page scroll), `user-select: none`, `-webkit-touch-callout: none`.
- Z-order: shell children sit above the player but below the lesson overlay system (`z-40`) — pricing/completed/soft-block overlays keep covering everything, so gestures are automatically inert when an overlay is up.

### Gesture state machine (pure + unit-testable)

Small reducer, no DOM: input events `{pointerdown, pointerup, move, timerExpired}` with `x`-zone (left 0–35% / center / right 65–100%) and timestamps → actions.

- **Single tap**: 250ms disambiguation timer → reveal/dismiss chrome, or resume while paused (see the interaction-model decision above; the machine only reports "single tap" — the shell maps it).
- **Double tap in a side zone**: cancels the timer → `SEEK(±5)`, but only when both taps land in the same zone (a cross-zone pair restarts as a fresh first tap); enters accumulate mode (~650ms rolling window) where each further tap on the same side adds ±5 and the label counts up "10 seconds", "15 seconds". Chrome stays hidden (YouTube parity).
- **Double tap in the center dead zone**: treated as single tap.
- **Long-press ≥500ms** (P2): `SPEED_HOLD_START` → set `playbackRate = 2` (stash prior rate); `pointerup` → restore. Known harmless quirk: `onRateChange` will transiently persist 2x to the prefs cookie and then persist the restored rate — net state correct.
- **Pointer moved >10px or multi-touch**: cancel everything (it's a scroll/pinch).
- Seeks clamp to `[0, duration]` and go through `currentTime` assignment, so the existing throttled `persistPlaybackPosition` pipeline is untouched.

### Feedback UI

- Ripple: semicircular flash anchored to the tapped edge + `▶▶▶` glyphs + "NN seconds" label; framer-motion (already a dependency, v12) with the app's existing `useReducedMotion` precedent — reduced motion gets the label without the ripple scale.
- Centered play/pause: the shell's own single 72px button, fading with the chrome (the 3-button center cluster was rejected in testing — it covered the screencast; on-video seek buttons too — double-tap corners is the idiom). It doubles as the pre-play affordance.
- gerwig's own centered play is hidden (and the bottom-bar play re-enabled) via inline styles on the media-controller — `--center-play-button: none` / `--bottom-play-button: inline-flex` — because gerwig's `exportparts` exposes no `controller` part, so no page-level CSS can reach it.
- All overlays use fixed light-on-dark scrim colors (they sit on video frames, not page surfaces — theme tokens would go unreadable over footage in light mode).

### Analytics

`track('video_gesture', { gesture, direction?, key? })` through the existing `track()` util, debounced per accumulate-burst. Shipped gesture names: `tap_reveal_chrome`, `tap_play_toggle`, `tap_hide_chrome`, `double_tap_seek`, `long_press_speed`, `center_play_button`, `double_click_fullscreen`, `speed_step`, `chapter_key`, `global_hotkey` — so we can tell Andrew (and ourselves) whether it's used.

## Rollout

All learner-facing video reduces to two integration points, both of which already hold the typed ref:

1. `AuthedVideoPlayer` (`src/app/(content)/_components/authed-video-player.tsx`) — every workshop + cohort lesson (cohorts route through `/workshops/[module]/[lesson]`). Needs the new wrapper (the player currently renders with no wrapper element; the shell takes over the `aspect-video … md:max-h-[75svh] md:max-w-[calc(75svh*16/9)]` caps from `shared-page.tsx`).
2. `PostPlayer` (`src/app/(content)/posts/_components/post-player.tsx`) — free posts, skills pages, changelogs (`[post]` and `skills/[slug]` routes both render it).

Also adopted: `MDXVideo` (`src/components/content/mdx-video.tsx`) — free MDX embeds (no chromeSlot there). Out of scope: hero video (muted, `pointer-events-none`, decorative), `team-video` (marketing, own overlay), CMS preview players — the coarse-pointer CSS sizing is scoped to `[data-player-gesture-shell]` so these keep stock chrome.

### What shipped (single PR — #134, decided 2026-08-20)

The staged 3-PR sequence was collapsed by decision into one PR shipped the same day: gesture shell with the full touch model (#1, #2, #4), coarse-pointer sizing (#3), long-press 2x (#5), `fullscreen-element` wrapper (#6), MDX adoption (#7), the whole desktop bucket (#8–#12), page-wide hotkeys, the autoplay toggle in the touch chrome, 5s seek offsets everywhere, and the transcript-ref fix (`.brain/tasks/lesson-player-ref-and-playsinline-fixes.svx`). Gated on the device QA checklist below; previews via vojta.ngrok.app per the usual triage flow.

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

1. ~~`autohide` timing~~ — resolved: the shell owns hiding entirely (`autohide="-1"` on the controller) with YouTube timings: ~3s idle, ~1s after play starts.
2. Center dead-zone width — shipped at side-35% / center-30%; tune on device if seeks misfire.
3. ~~Centered play button~~ — resolved (twice): the shell renders its own 72px centered play/pause with the chrome; gerwig's is hidden.

## External validation

Eleken's video-player UI guide (reviewed 2026-08-20) independently lands on the same choices: auto-hide that's easy to summon, central play affordance, double-tap skip, thumbnail scrubbing with chapter markers, input-adaptive target sizes, speed controls emphasized for learning platforms, and "a redesign that does less rarely feels like an improvement" (we removed nothing). One idea worth a future look: **the paused state as usable real estate** — chapter navigation, transcript, or recommendations while paused. Filed as a product question, not player work.

## Verified facts this spec rests on

- Touch tap-to-play/pause and double-tap seek are absent by design in media-chrome 4.19 (empty `handleTap`, source TODO); tap-toggle-chrome lives in `media-container.ts` and can't be disabled alone.
- `fullscreen-element` attribute is documented and wired in `base.mjs` (sets `mediaController.fullscreenElement`).
- `userinactivechange` is composed+bubbling → observable from React on the player element.
- `playsinline` is hardcoded on the internal `<mux-video>` — do not add the prop.
- Seek offsets already default to 10s (buttons + keyboard); `j`/`l` hotkeys already work.
- gerwig hides bottom play/seek/time controls below 470px (`breakpoints="sm:470"` hardcoded).
- No gesture code or gesture library exists in the app today; framer-motion v12 is available for the feedback UI.
