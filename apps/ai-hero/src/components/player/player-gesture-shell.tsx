'use client'

import * as React from 'react'
import { track } from '@/utils/analytics'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Pause, Play } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import {
	createGestureMachine,
	type GestureZone,
} from './video-gesture-machine'

// 5s like YouTube's arrow keys — our videos are short, 10s overshoots.
const SEEK_SECONDS = 5
// YouTube-ish timings: ~3s idle hide after an interaction, but a much
// quicker drop once playback (re)starts.
const CHROME_HIDE_MS = 3000
const CHROME_HIDE_AFTER_PLAY_MS = 1000
const TOAST_MS = 800
const RIPPLE_MS = 700
const DEFAULT_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

type MediaControllerElement = HTMLElement & {
	autohide: string
}

// media-controller's own autohide CSS refuses to fade the chrome while
// paused (`:not([mediapaused])` in its :host rule) and gerwig keeps its
// backdrop up. Our touch model hides on tap regardless of play state, so
// on coarse pointers we append these two rules into the (open) shadow
// roots as constructed stylesheets — removable, and a no-op if a future
// bundle closes the roots (controls then just stay pinned while paused).
const PAUSED_HIDE_CONTROLLER_CSS = `:host([userinactive][mediapaused]:not([mediaisairplaying]):not([mediaiscasting]):not([audio])) ::slotted(:not([slot="media"]):not([slot="poster"]):not([noautohide]):not([role="dialog"])) { opacity: 0; transition: var(--media-control-transition-out, opacity 1s); }`
const PAUSED_HIDE_THEME_CSS = `media-controller[userinactive][mediapaused]::part(vertical-layer) { background-color: transparent; }`

// The bundled media-chrome inside mux-player exposes no working
// `userInactive` property setter — drive the attribute directly, which
// is what media-chrome's own show/hide code does. The chrome CSS reacts
// to the attribute.
function setControllerInactive(mc: MediaControllerElement, inactive: boolean) {
	if (inactive) mc.setAttribute('userinactive', '')
	else mc.removeAttribute('userinactive')
}

function getMediaController(
	player: MuxPlayerRefAttributes | null,
): MediaControllerElement | null {
	return (
		(player as unknown as { mediaController?: MediaControllerElement })
			?.mediaController ?? null
	)
}

function getChapterCues(player: MuxPlayerRefAttributes): VTTCue[] {
	const tracks = Array.from(player.textTracks ?? [])
	const chapterTrack = tracks.find((t) => t.kind === 'chapters')
	if (!chapterTrack?.cues) return []
	return Array.from(chapterTrack.cues) as VTTCue[]
}

function isVideoAreaEvent(event: Event) {
	return event
		.composedPath()
		.some((el) =>
			['media-gesture-receiver', 'mux-video', 'video'].includes(
				(el as HTMLElement)?.localName,
			),
		)
}

const HOTKEY_EXEMPT_ROLES = new Set([
	'textbox',
	'searchbox',
	'combobox',
	'listbox',
	'menu',
	'menubar',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'slider',
	'spinbutton',
	'tablist',
	'tab',
	'radiogroup',
	// Space/arrow-driven toggle and composite widgets (non-native ones —
	// native inputs are covered by the localName check below).
	'checkbox',
	'radio',
	'switch',
	'option',
	'grid',
	'gridcell',
	'treegrid',
	'tree',
	'treeitem',
])

/**
 * Standard global-hotkey exemptions: anything the user might be typing in
 * or steering with arrow keys keeps its native behavior.
 */
function isTypingTarget(event: Event) {
	if ((event as KeyboardEvent).isComposing) return true
	for (const node of event.composedPath()) {
		const el = node as HTMLElement
		if (!el?.localName) continue
		if (['input', 'textarea', 'select', 'audio', 'video'].includes(el.localName))
			return true
		if (el.isContentEditable) return true
		const role = el.getAttribute?.('role')
		if (role && HOTKEY_EXEMPT_ROLES.has(role)) return true
	}
	return false
}

/**
 * YouTube-style gesture layer around a MuxPlayer.
 *
 * On coarse pointers it owns the touch interaction model: a background
 * tap reveals the chrome when hidden (with a big centered play/pause
 * button) and hides it when up — playing or paused (pre-play, a tap
 * starts playback). Double-tap on the side thirds seeks ±5s (with
 * accumulation), press-and-hold plays at 2x, and the chrome auto-hides
 * ~1s after play starts / ~3s after interactions while playing.
 * On fine pointers it adds
 * double-click fullscreen, click-and-hold 2x, chapter keys (Ctrl/⌘+arrows),
 * `<`/`>` speed stepping, and an on-screen HUD for the built-in keyboard
 * shortcuts. The wrapper is also the player's `fullscreen-element`, so all
 * of it survives fullscreen where element fullscreen exists (not iPhone).
 */
export function PlayerGestureShell({
	playerRef,
	className,
	children,
	chromeSlot,
}: {
	playerRef: React.RefObject<MuxPlayerRefAttributes | null>
	className?: string
	children: React.ReactNode
	/** Extra control rendered in the touch chrome's top-left (e.g. autoplay toggle), fading with the chrome. */
	chromeSlot?: React.ReactNode
}) {
	const shellId = React.useId()
	const shellRef = React.useRef<HTMLDivElement>(null)
	const prefersReducedMotion = useReducedMotion()

	const [isCoarse, setIsCoarse] = React.useState(false)
	const [chromeVisible, setChromeVisible] = React.useState(false)
	const [paused, setPausedState] = React.useState(true)
	const [hasPlayed, setHasPlayed] = React.useState(false)
	const [ripple, setRipple] = React.useState<{
		zone: 'left' | 'right'
		seconds: number
		key: number
	} | null>(null)
	const [toast, setToast] = React.useState<{
		text: string
		key: number
	} | null>(null)
	const [holdActive, setHoldActive] = React.useState(false)
	const [playFlash, setPlayFlash] = React.useState<{
		kind: 'play' | 'pause'
		key: number
	} | null>(null)

	const chromeVisibleRef = React.useRef(chromeVisible)
	React.useEffect(() => {
		chromeVisibleRef.current = chromeVisible
	}, [chromeVisible])
	const pausedRef = React.useRef(true)
	const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
	const rippleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
		null,
	)
	const toastTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
		null,
	)
	const holdPrevRateRef = React.useRef<number | null>(null)
	const holdConsumedClickRef = React.useRef(false)
	const mouseHoldTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
		null,
	)
	const activePointerIdRef = React.useRef<number | null>(null)
	const keyCounterRef = React.useRef(0)

	React.useEffect(() => {
		const mq = window.matchMedia('(pointer: coarse)')
		setIsCoarse(mq.matches)
		const onChange = (e: MediaQueryListEvent) => setIsCoarse(e.matches)
		mq.addEventListener('change', onChange)
		return () => mq.removeEventListener('change', onChange)
	}, [])

	const clearHideTimer = React.useCallback(() => {
		if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
		hideTimerRef.current = null
	}, [])

	const setChrome = React.useCallback(
		(visible: boolean, hideAfterMs = CHROME_HIDE_MS) => {
			const mc = getMediaController(playerRef.current)
			if (mc) setControllerInactive(mc, !visible)
			chromeVisibleRef.current = visible
			setChromeVisible(visible)
			clearHideTimer()
			if (visible && !pausedRef.current) {
				hideTimerRef.current = setTimeout(() => {
					const inner = getMediaController(playerRef.current)
					if (inner) setControllerInactive(inner, true)
					chromeVisibleRef.current = false
					setChromeVisible(false)
				}, hideAfterMs)
			}
		},
		[playerRef, clearHideTimer],
	)

	// A tap anywhere off the video instantly hides the chrome — playing or
	// paused — the page tap both scrolls/acts AND dismisses, YouTube-style.
	React.useEffect(() => {
		if (!isCoarse) return
		const onDocPointerDown = (e: PointerEvent) => {
			if (!chromeVisibleRef.current) return
			const mc = getMediaController(playerRef.current)
			// Pre-play the chrome is the only affordance — leave it up.
			if (mc && !mc.hasAttribute('mediahasplayed')) return
			const shell = shellRef.current
			if (shell && e.composedPath().includes(shell)) return
			setChrome(false)
		}
		document.addEventListener('pointerdown', onDocPointerDown, true)
		return () =>
			document.removeEventListener('pointerdown', onDocPointerDown, true)
	}, [isCoarse, setChrome, playerRef])

	const armHideTimer = React.useCallback(() => {
		if (!chromeVisibleRef.current) return
		setChrome(true)
	}, [setChrome])

	const flashToast = React.useCallback((text: string) => {
		if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
		setToast({ text, key: ++keyCounterRef.current })
		toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS)
	}, [])

	const seekBy = React.useCallback(
		(delta: number) => {
			const player = playerRef.current
			if (!player) return
			const duration = Number.isFinite(player.duration)
				? player.duration
				: Infinity
			player.currentTime = Math.min(
				Math.max(player.currentTime + delta, 0),
				duration,
			)
		},
		[playerRef],
	)

	const beginHoldSpeed = React.useCallback(() => {
		const player = playerRef.current
		if (!player || player.paused) return
		holdPrevRateRef.current = player.playbackRate
		player.playbackRate = 2
		setHoldActive(true)
		void track('video_gesture', { gesture: 'long_press_speed' })
	}, [playerRef])

	const endHoldSpeed = React.useCallback(() => {
		const player = playerRef.current
		if (player && holdPrevRateRef.current !== null) {
			player.playbackRate = holdPrevRateRef.current
		}
		holdPrevRateRef.current = null
		setHoldActive(false)
	}, [playerRef])

	// YouTube-native two-step model, play-state-agnostic: a background tap
	// reveals the chrome when hidden and hides it when up — paused or
	// playing makes no difference (play/pause is the centered/bottom
	// button). The one exception is pre-play, where a tap starts playback
	// instead of hiding the only affordance on screen.
	const handleSingleTap = React.useCallback(() => {
		const player = playerRef.current
		if (!player) return
		const mc = getMediaController(player)
		// Pre-play first: the controller carries `userinactive` before any
		// interaction, so this can't wait behind the visibility branch.
		const hasPlayedYet = mc
			? mc.hasAttribute('mediahasplayed')
			: !player.paused
		if (player.paused && !hasPlayedYet) {
			void player.play().catch(() => {})
			void track('video_gesture', { gesture: 'tap_play_toggle' })
			return
		}
		const chromeShowing = mc
			? !mc.hasAttribute('userinactive')
			: chromeVisibleRef.current
		if (!chromeShowing) {
			setChrome(true)
			void track('video_gesture', { gesture: 'tap_reveal_chrome' })
			return
		}
		setChrome(false)
		void track('video_gesture', { gesture: 'tap_hide_chrome' })
	}, [playerRef, setChrome])
	const handleSingleTapRef = React.useRef(handleSingleTap)
	handleSingleTapRef.current = handleSingleTap

	// Touch gesture machine (coarse pointers).
	const machineRef = React.useRef<ReturnType<
		typeof createGestureMachine
	> | null>(null)
	if (machineRef.current === null) {
		machineRef.current = createGestureMachine(
			{
			onSingleTap: () => handleSingleTapRef.current(),
			onSeek: (delta, burst, zone) => {
				seekBy(delta)
				if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current)
				setRipple({
					zone: zone as 'left' | 'right',
					seconds: burst,
					key: ++keyCounterRef.current,
				})
				rippleTimerRef.current = setTimeout(() => setRipple(null), RIPPLE_MS)
				if (burst === SEEK_SECONDS) {
					void track('video_gesture', {
						gesture: 'double_tap_seek',
						direction: delta > 0 ? 'forward' : 'backward',
					})
				}
			},
			onHoldStart: beginHoldSpeed,
				onHoldEnd: () => {
					if (holdPrevRateRef.current === null) {
						// The hold never engaged 2x (e.g. while paused): a lingering
						// tap should still act as a tap, not die silently.
						handleSingleTapRef.current()
						return
					}
					endHoldSpeed()
				},
			},
			{ seekSeconds: SEEK_SECONDS },
		)
	}
	React.useEffect(
		() => () => {
			machineRef.current?.destroy()
			if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
			if (rippleTimerRef.current) clearTimeout(rippleTimerRef.current)
			if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
			if (mouseHoldTimerRef.current) clearTimeout(mouseHoldTimerRef.current)
			// Restore the rate directly (no setState on an unmounted tree) so
			// unmounting mid-hold can't leave the player stuck at 2x.
			const player = playerRef.current
			if (player && holdPrevRateRef.current !== null) {
				player.playbackRate = holdPrevRateRef.current
			}
		},
		[playerRef],
	)

	// Player wiring: fullscreen container, visibility ownership, media events.
	React.useEffect(() => {
		const player = playerRef.current
		const shell = shellRef.current
		if (!player || !shell) return

		shell.id = shellId
		player.setAttribute('fullscreen-element', shellId)

		const mc = getMediaController(player)
		const prevAutohide = mc?.getAttribute('autohide') ?? null
		const injectedSheets: Array<{ root: ShadowRoot; sheet: CSSStyleSheet }> = []
		const injectSheet = (root: ShadowRoot | null | undefined, css: string) => {
			if (!root) return
			try {
				const sheet = new CSSStyleSheet()
				sheet.replaceSync(css)
				root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]
				injectedSheets.push({ root, sheet })
			} catch {}
		}
		if (isCoarse && mc) {
			// Let the chrome hide while paused too (tap-to-hide is
			// play-state-agnostic in our model; media-chrome's own CSS pins it).
			injectSheet(mc.shadowRoot, PAUSED_HIDE_CONTROLLER_CSS)
			injectSheet(
				(player as unknown as { shadowRoot?: ShadowRoot }).shadowRoot?.
					querySelector('media-theme')?.shadowRoot,
				PAUSED_HIDE_THEME_CSS,
			)
			// We own show/hide on touch: the container's own tap/autohide logic
			// is target-dependent and its timers are private. -1 disables them.
			mc.setAttribute('autohide', '-1')
			// Inline styles because gerwig exports no "controller" part (no
			// page CSS can reach the element) and its shadow rules beat
			// inherited values. The shell's centered button replaces gerwig's
			// (which is template-gated to <470px and never exists on iPads);
			// the bottom play button is gerwig's own, unhidden and touch-sized.
			mc.style.setProperty('--center-play-button', 'none')
			mc.style.setProperty('--bottom-play-button', 'inline-flex')
		}

		const onUserInactiveChange = (evt: Event) => {
			const inactive = Boolean((evt as CustomEvent).detail)
			chromeVisibleRef.current = !inactive
			setChromeVisible(!inactive)
			// The chrome can be shown by media-chrome's own paths (pre-play tap,
			// keyup, stray pointer events). With autohide -1 the container never
			// hides it again, so every show must re-arm our hide timer.
			if (!inactive && isCoarse) setChrome(true)
		}
		const onPlay = () => {
			pausedRef.current = false
			setPausedState(false)
			setHasPlayed(true)
			// On touch with the chrome up, the center button's icon flip IS the
			// feedback; the flash is for state changes without a visible button.
			const mcPlay = getMediaController(playerRef.current)
			const chromeUp = mcPlay ? !mcPlay.hasAttribute('userinactive') : false
			if (!(isCoarse && chromeUp))
				setPlayFlash({ kind: 'play', key: ++keyCounterRef.current })
			// Chrome clears out fast once playback starts, YouTube-style.
			// The userinactive attribute is the truth for visibility — the
			// React mirror can drift if a show happened before hydration.
			const mcNow = getMediaController(player)
			const visibleNow = mcNow
				? !mcNow.hasAttribute('userinactive')
				: chromeVisibleRef.current
			if (isCoarse && visibleNow) setChrome(true, CHROME_HIDE_AFTER_PLAY_MS)
		}
		const onPause = () => {
			pausedRef.current = true
			setPausedState(true)
			const mcPause = getMediaController(playerRef.current)
			const chromeUpAtPause = mcPause
				? !mcPause.hasAttribute('userinactive')
				: false
			if (!(isCoarse && chromeUpAtPause))
				setPlayFlash({ kind: 'pause', key: ++keyCounterRef.current })
			endHoldSpeed()
			if (isCoarse) setChrome(true)
		}

		player.addEventListener('userinactivechange', onUserInactiveChange)
		player.addEventListener('play', onPlay)
		player.addEventListener('pause', onPause)
		return () => {
			player.removeEventListener('userinactivechange', onUserInactiveChange)
			player.removeEventListener('play', onPlay)
			player.removeEventListener('pause', onPause)
			// Undo the coarse-pointer takeover so a pointer-type flip (e.g.
			// detaching a touchscreen laptop's mouse) hands auto-hide and the
			// button layout back to media-chrome's defaults.
			if (isCoarse && mc) {
				if (prevAutohide === null) mc.removeAttribute('autohide')
				else mc.setAttribute('autohide', prevAutohide)
				mc.style.removeProperty('--center-play-button')
				mc.style.removeProperty('--bottom-play-button')
			}
			for (const { root, sheet } of injectedSheets) {
				root.adoptedStyleSheets = root.adoptedStyleSheets.filter(
					(s) => s !== sheet,
				)
			}
		}
	}, [playerRef, shellId, isCoarse, setChrome, endHoldSpeed])

	// Desktop extras: chapter keys, speed stepping, keyboard HUD, and the
	// click swallow after a mouse hold. Native capture listeners so we run
	// before media-controller's own handlers.
	React.useEffect(() => {
		const shell = shellRef.current
		if (!shell) return

		const stepRate = (direction: 1 | -1) => {
			const player = playerRef.current
			if (!player) return
			const rates = DEFAULT_RATES
			const current = player.playbackRate
			// Nearest preset strictly past the current rate, so off-preset
			// rates (e.g. 1.1) step to the adjacent preset instead of
			// skipping one.
			const next =
				direction === 1
					? rates.find((r) => r > current + 0.001)
					: [...rates].reverse().find((r) => r < current - 0.001)
			if (next === undefined) return
			player.playbackRate = next
			flashToast(`${next}x`)
			void track('video_gesture', { gesture: 'speed_step' })
		}

		const seekChapter = (direction: 1 | -1) => {
			const player = playerRef.current
			if (!player) return
			const cues = getChapterCues(player)
			if (!cues.length) return
			const now = player.currentTime
			if (direction > 0) {
				const next = cues.find((c) => c.startTime > now + 0.5)
				if (!next) return
				player.currentTime = next.startTime
				flashToast(next.text)
			} else {
				let currentIndex = -1
				for (let i = cues.length - 1; i >= 0; i--) {
					if (cues[i]!.startTime <= now) {
						currentIndex = i
						break
					}
				}
				if (currentIndex === -1) return
				const current = cues[currentIndex]!
				const target =
					now - current.startTime > 2
						? current
						: (cues[currentIndex - 1] ?? current)
				player.currentTime = target.startTime
				flashToast(target.text)
			}
			void track('video_gesture', { gesture: 'chapter_key' })
		}

		const onKeyDown = (e: KeyboardEvent) => {
			if (isTypingTarget(e)) return
			if ((e.ctrlKey || e.metaKey) && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
				// Stop it here or media-controller seeks ±10s on the same key.
				e.preventDefault()
				e.stopPropagation()
				seekChapter(e.key === 'ArrowRight' ? 1 : -1)
				return
			}
			if (e.ctrlKey || e.metaKey || e.altKey) return
			// Some layouts/synthetic keyboards report shift+. rather than '>'.
			if (e.key === '>' || (e.shiftKey && e.key === '.')) {
				stepRate(1)
				return
			}
			if (e.key === '<' || (e.shiftKey && e.key === ',')) {
				stepRate(-1)
				return
			}
			// HUD flashes only echo keys media-controller will actually handle,
			// which requires focus inside the player.
			const focusInPlayer = e
				.composedPath()
				.some(
					(el) => (el as HTMLElement)?.localName === 'media-controller',
				)
			if (!focusInPlayer) return
			if (['ArrowLeft', 'j'].includes(e.key)) {
				flashToast(`−${SEEK_SECONDS}s`)
				return
			}
			if (['ArrowRight', 'l'].includes(e.key)) {
				flashToast(`+${SEEK_SECONDS}s`)
				return
			}
			if (['ArrowUp', 'ArrowDown'].includes(e.key)) {
				requestAnimationFrame(() => {
					const player = playerRef.current
					if (!player) return
					const level = player.muted ? 0 : player.volume
					flashToast(`Volume ${Math.round(level * 100)}%`)
				})
			}
		}

		const onClickCapture = (e: MouseEvent) => {
			if (holdConsumedClickRef.current) {
				// The press was a hold-for-2x, not a click: keep the built-in
				// mouse click-to-pause from firing on release.
				e.preventDefault()
				e.stopPropagation()
				holdConsumedClickRef.current = false
			}
		}

		shell.addEventListener('keydown', onKeyDown, true)
		shell.addEventListener('click', onClickCapture, true)
		return () => {
			shell.removeEventListener('keydown', onKeyDown, true)
			shell.removeEventListener('click', onClickCapture, true)
		}
	}, [playerRef, flashToast])

	const toggleFullscreen = React.useCallback(() => {
		const mc = getMediaController(playerRef.current)
		if (!mc) return
		const eventName = document.fullscreenElement
			? 'mediaexitfullscreenrequest'
			: 'mediaenterfullscreenrequest'
		mc.dispatchEvent(
			new CustomEvent(eventName, { composed: true, bubbles: true }),
		)
		void track('video_gesture', { gesture: 'double_click_fullscreen' })
	}, [playerRef])

	// Page-wide shortcuts: seek/play/mute/fullscreen work without the
	// player being focused, YouTube-style. When focus IS inside the player
	// media-chrome's own hotkeys handle it (skip to avoid double-seeks);
	// defaultPrevented guards typing fields and a second player on the page.
	React.useEffect(() => {
		const onGlobalKeyDown = (e: KeyboardEvent) => {
			if (e.defaultPrevented) return
			if (e.ctrlKey || e.metaKey || e.altKey) return
			if (isTypingTarget(e)) return
			const player = playerRef.current
			if (!player) return
			if (e.composedPath().includes(player)) return
			switch (e.key) {
				case 'ArrowLeft':
				case 'j':
					seekBy(-SEEK_SECONDS)
					flashToast(`−${SEEK_SECONDS}s`)
					break
				case 'ArrowRight':
				case 'l':
					seekBy(SEEK_SECONDS)
					flashToast(`+${SEEK_SECONDS}s`)
					break
				case 'k':
					if (player.paused) void player.play().catch(() => {})
					else player.pause()
					break
				case ' ': {
					// Space still activates focused controls (buttons, links);
					// only body-level space becomes play/pause instead of scroll.
					const onControl = e
						.composedPath()
						.some((node) => {
							const el = node as HTMLElement
							return (
								['button', 'a', 'summary'].includes(el?.localName) ||
								el?.getAttribute?.('role') === 'button'
							)
						})
					if (onControl) return
					if (player.paused) void player.play().catch(() => {})
					else player.pause()
					break
				}
				case 'm':
					player.muted = !player.muted
					flashToast(player.muted ? 'Muted' : 'Unmuted')
					break
				case 'f':
					toggleFullscreen()
					break
				default:
					return
			}
			e.preventDefault()
			void track('video_gesture', { gesture: 'global_hotkey', key: e.key })
		}
		document.addEventListener('keydown', onGlobalKeyDown)
		return () => document.removeEventListener('keydown', onGlobalKeyDown)
	}, [playerRef, seekBy, flashToast, toggleFullscreen])

	// Mouse press-and-hold for 2x (fine pointers, video area only).
	// Pointer capture is off the table here: it would retarget the
	// compatibility `click` away from media-chrome's own click-to-pause.
	// Window-level capture listeners guarantee the release is seen even
	// when the mouse leaves the shell before letting go.
	const onShellPointerDown = React.useCallback(
		(e: React.PointerEvent) => {
			if (e.pointerType !== 'mouse' || e.button !== 0) return
			if (!isVideoAreaEvent(e.nativeEvent)) return
			if (mouseHoldTimerRef.current) clearTimeout(mouseHoldTimerRef.current)
			mouseHoldTimerRef.current = setTimeout(() => {
				mouseHoldTimerRef.current = null
				// Only a hold that actually engages 2x consumes the click —
				// holding a paused video must still click-to-play on release.
				const player = playerRef.current
				if (!player || player.paused) return
				holdConsumedClickRef.current = true
				beginHoldSpeed()
			}, 500)
			const ac = new AbortController()
			const finish = (evt: Event) => {
				ac.abort()
				if (mouseHoldTimerRef.current) {
					clearTimeout(mouseHoldTimerRef.current)
					mouseHoldTimerRef.current = null
				}
				if (holdPrevRateRef.current !== null) endHoldSpeed()
				// An outside release produces no click on the shell, so the
				// swallow flag would go stale and eat the next real click.
				const shell = shellRef.current
				if (!shell || !evt.composedPath().includes(shell)) {
					holdConsumedClickRef.current = false
				}
			}
			window.addEventListener('pointerup', finish, {
				capture: true,
				signal: ac.signal,
			})
			window.addEventListener('pointercancel', finish, {
				capture: true,
				signal: ac.signal,
			})
		},
		[playerRef, beginHoldSpeed, endHoldSpeed],
	)
	const onShellPointerUp = React.useCallback(() => {
		armHideTimer()
	}, [armHideTimer])
	const onShellDoubleClick = React.useCallback(
		(e: React.MouseEvent) => {
			if (isCoarse) return
			if (!isVideoAreaEvent(e.nativeEvent)) return
			toggleFullscreen()
		},
		[isCoarse, toggleFullscreen],
	)

	// Touch surface handlers.
	const zoneForEvent = React.useCallback(
		(e: React.PointerEvent): GestureZone => {
			const rect = shellRef.current?.getBoundingClientRect()
			if (!rect || rect.width === 0) return 'center'
			const x = (e.clientX - rect.left) / rect.width
			if (x < 0.35) return 'left'
			if (x > 0.65) return 'right'
			return 'center'
		},
		[],
	)
	const onSurfacePointerDown = React.useCallback(
		(e: React.PointerEvent) => {
			if (activePointerIdRef.current !== null) {
				// Second finger: pinch/scroll, never a gesture.
				machineRef.current?.cancel()
				activePointerIdRef.current = null
				return
			}
			activePointerIdRef.current = e.pointerId
			// Capture so pointerup always reaches us even if the surface
			// swaps geometry (chrome reveal) mid-tap — a lost up leaves a
			// stale id that would swallow the next tap as a phantom pinch.
			try {
				;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
			} catch {}
			machineRef.current?.pointerDown(zoneForEvent(e), e.clientX, e.clientY)
		},
		[zoneForEvent],
	)
	const onSurfacePointerMove = React.useCallback((e: React.PointerEvent) => {
		if (activePointerIdRef.current !== e.pointerId) return
		machineRef.current?.pointerMove(e.clientX, e.clientY)
	}, [])
	const onSurfacePointerUp = React.useCallback((e: React.PointerEvent) => {
		if (activePointerIdRef.current !== e.pointerId) return
		activePointerIdRef.current = null
		machineRef.current?.pointerUp()
	}, [])
	const onSurfacePointerCancel = React.useCallback(() => {
		activePointerIdRef.current = null
		machineRef.current?.cancel()
	}, [])

	const surfaceActive = isCoarse
	// Pre-play the chrome is pinned up (it's the only affordance); once
	// playback has started, visibility is tap-driven regardless of pause.
	const chromeShowing = chromeVisible || (paused && !hasPlayed)

	// Overlay styling note: everything below renders ON the video frame,
	// not on a page surface, so it uses fixed light-on-dark scrim colors
	// (bg-black/60, text-white) by design — theme tokens would flip to
	// dark-on-light in light mode and become unreadable over footage.
	return (
		<div
			ref={shellRef}
			data-player-gesture-shell=""
			className={cn('relative', className)}
			onPointerDown={onShellPointerDown}
			onPointerUp={onShellPointerUp}
			onDoubleClick={onShellDoubleClick}
		>
			{children}
			{surfaceActive && (
				<div
					aria-hidden="true"
					className={cn(
						'touch-manipulation absolute z-10 select-none',
						// With the chrome up, leave only the strips the chrome actually
						// occupies. Fixed 56/96px insets left a 49px sliver on a 201px
						// phone player — reserve fractions capped at the desktop sizes.
						chromeShowing
							? 'left-0 right-0 top-[min(48px,15%)] bottom-[min(88px,35%)]'
							: 'inset-0',
					)}
					style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
					onPointerDown={onSurfacePointerDown}
					onPointerMove={onSurfacePointerMove}
					onPointerUp={onSurfacePointerUp}
					onPointerCancel={onSurfacePointerCancel}
				/>
			)}
			{isCoarse && chromeSlot && (
				<div
					className={cn(
						'absolute left-2 top-2 z-20 transition-opacity duration-200',
						chromeShowing
							? 'opacity-100'
							: 'pointer-events-none opacity-0',
					)}
				>
					{chromeSlot}
				</div>
			)}
			{isCoarse && (
				<div
					className={cn(
						'pointer-events-none absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-200',
						chromeShowing ? 'opacity-100' : 'opacity-0',
					)}
				>
					<button
						type="button"
						aria-label={paused ? 'Play' : 'Pause'}
						tabIndex={chromeShowing ? 0 : -1}
						className={cn(
							'touch-manipulation flex h-[72px] w-[72px] items-center justify-center rounded-full bg-black/60 text-white transition-transform active:scale-95',
							chromeShowing ? 'pointer-events-auto' : 'pointer-events-none',
						)}
						onClick={() => {
							const player = playerRef.current
							if (!player) return
							if (player.paused) void player.play().catch(() => {})
							else player.pause()
							armHideTimer()
							void track('video_gesture', { gesture: 'center_play_button' })
						}}
					>
						{paused ? (
							<Play aria-hidden="true" className="ml-1 h-9 w-9 fill-current" />
						) : (
							<Pause aria-hidden="true" className="h-9 w-9 fill-current" />
						)}
					</button>
				</div>
			)}
			{playFlash && (
				<div
					key={playFlash.key}
					className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"
				>
					<motion.div
						initial={{ opacity: 0.9, scale: prefersReducedMotion ? 1 : 0.7 }}
						animate={{ opacity: 0, scale: prefersReducedMotion ? 1 : 1.3 }}
						transition={{ duration: 0.5, ease: 'easeOut' }}
						onAnimationComplete={() => setPlayFlash(null)}
						className="flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white"
					>
						{playFlash.kind === 'play' ? (
							<Play aria-hidden="true" className="ml-1 h-8 w-8 fill-current" />
						) : (
							<Pause aria-hidden="true" className="h-8 w-8 fill-current" />
						)}
					</motion.div>
				</div>
			)}
			<AnimatePresence>
				{ripple && (
					<motion.div
						key={ripple.key}
						initial={{ opacity: 0, scale: prefersReducedMotion ? 1 : 0.85 }}
						animate={{ opacity: 1, scale: 1 }}
						exit={{ opacity: 0 }}
						transition={{ duration: 0.15 }}
						className={cn(
							'pointer-events-none absolute bottom-0 top-0 z-20 flex w-[35%] items-center justify-center bg-white/10',
							ripple.zone === 'left'
								? 'left-0 rounded-r-[100%]'
								: 'right-0 rounded-l-[100%]',
						)}
					>
						<div className="flex flex-col items-center gap-1 text-white">
							<span className="text-lg font-semibold tracking-widest">
								{ripple.zone === 'left' ? '❮❮' : '❯❯'}
							</span>
							<span className="text-sm font-medium">
								{ripple.seconds} seconds
							</span>
						</div>
					</motion.div>
				)}
			</AnimatePresence>
			<AnimatePresence>
				{(holdActive || toast) && (
					<div
						key={holdActive ? 'hold' : toast?.key}
						className="pointer-events-none absolute left-1/2 top-4 z-20 -translate-x-1/2"
					>
						{/* Motion animates transform, so the centering translate lives
						    on a wrapper it never touches. */}
						<motion.div
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							exit={{ opacity: 0 }}
							transition={{ duration: 0.12 }}
							className="rounded-[9px] bg-black/70 px-3 py-1 text-sm font-medium text-white"
						>
							{holdActive ? '2x ❯❯' : toast?.text}
						</motion.div>
					</div>
				)}
			</AnimatePresence>
		</div>
	)
}

