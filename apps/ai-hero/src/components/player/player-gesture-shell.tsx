'use client'

import * as React from 'react'
import { track } from '@/utils/analytics'
import type { MuxPlayerRefAttributes } from '@mux/mux-player-react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Pause, Play, RotateCcw, RotateCw } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import {
	createGestureMachine,
	type GestureZone,
} from './video-gesture-machine'

const SEEK_SECONDS = 10
const CHROME_HIDE_MS = 3000
const TOAST_MS = 800
const RIPPLE_MS = 700
const DEFAULT_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

type MediaControllerElement = HTMLElement & {
	userInactive: boolean
	autohide: string
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

function isTypingTarget(event: Event) {
	const el = event.composedPath()[0] as HTMLElement | undefined
	if (!el) return false
	return (
		['input', 'textarea', 'select'].includes(el.localName) ||
		el.isContentEditable
	)
}

/**
 * YouTube-style gesture layer around a MuxPlayer.
 *
 * On coarse pointers it owns the touch interaction model: single tap toggles
 * the chrome, double-tap on the side thirds seeks ±10s (with accumulation),
 * press-and-hold plays at 2x, and a big centered ⏪10 / play-pause / ⏩10
 * cluster shows whenever the chrome does. On fine pointers it adds
 * double-click fullscreen, click-and-hold 2x, chapter keys (Ctrl/⌘+arrows),
 * `<`/`>` speed stepping, and an on-screen HUD for the built-in keyboard
 * shortcuts. The wrapper is also the player's `fullscreen-element`, so all
 * of it survives fullscreen where element fullscreen exists (not iPhone).
 */
export function PlayerGestureShell({
	playerRef,
	className,
	children,
}: {
	playerRef: React.RefObject<MuxPlayerRefAttributes | null>
	className?: string
	children: React.ReactNode
}) {
	const shellId = React.useId()
	const shellRef = React.useRef<HTMLDivElement>(null)
	const prefersReducedMotion = useReducedMotion()

	const [isCoarse, setIsCoarse] = React.useState(false)
	const [chromeVisible, setChromeVisible] = React.useState(false)
	const [paused, setPaused] = React.useState(true)
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

	const chromeVisibleRef = React.useRef(chromeVisible)
	chromeVisibleRef.current = chromeVisible
	const pausedRef = React.useRef(paused)
	pausedRef.current = paused
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
		(visible: boolean) => {
			const mc = getMediaController(playerRef.current)
			if (mc) mc.userInactive = !visible
			setChromeVisible(visible)
			clearHideTimer()
			if (visible && !pausedRef.current) {
				hideTimerRef.current = setTimeout(() => {
					const inner = getMediaController(playerRef.current)
					if (inner) inner.userInactive = true
					setChromeVisible(false)
				}, CHROME_HIDE_MS)
			}
		},
		[playerRef, clearHideTimer],
	)

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

	// Touch gesture machine (coarse pointers).
	const machineRef = React.useRef<ReturnType<
		typeof createGestureMachine
	> | null>(null)
	if (machineRef.current === null) {
		machineRef.current = createGestureMachine({
			// Vojta's call (2026-08-20): tap pauses/resumes directly, YouTube
			// desktop-web style, rather than the native app's reveal-then-act.
			// Chrome visibility follows: pause shows it, play re-arms auto-hide.
			onSingleTap: () => {
				const player = playerRef.current
				if (!player) return
				if (player.paused) void player.play().catch(() => {})
				else player.pause()
				void track('video_gesture', { gesture: 'tap_play_toggle' })
			},
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
			onHoldEnd: endHoldSpeed,
		})
	}
	React.useEffect(() => () => machineRef.current?.destroy(), [])

	// Player wiring: fullscreen container, visibility ownership, media events.
	React.useEffect(() => {
		const player = playerRef.current
		const shell = shellRef.current
		if (!player || !shell) return

		shell.id = shellId
		player.setAttribute('fullscreen-element', shellId)

		const mc = getMediaController(player)
		if (isCoarse && mc) {
			// We own show/hide on touch: the container's own tap/autohide logic
			// is target-dependent and its timers are private. -1 disables them.
			mc.setAttribute('autohide', '-1')
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
			// The ref must lead the state: setChrome reads it synchronously.
			pausedRef.current = false
			setPaused(false)
			setHasPlayed(true)
			if (isCoarse && chromeVisibleRef.current) setChrome(true)
		}
		const onPause = () => {
			pausedRef.current = true
			setPaused(true)
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
		}
	}, [playerRef, shellId, isCoarse, setChrome, endHoldSpeed])

	// Hide the theme's own small centered play button while our cluster is up.
	React.useEffect(() => {
		const player = playerRef.current
		if (!player) return
		if (isCoarse && hasPlayed) {
			player.style.setProperty('--center-play-button', 'none')
			return () => {
				player.style.removeProperty('--center-play-button')
			}
		}
	}, [playerRef, isCoarse, hasPlayed])

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
			const index = rates.findIndex((r) => r >= current - 0.001)
			const nextIndex = Math.min(
				Math.max((index === -1 ? rates.length - 1 : index) + direction, 0),
				rates.length - 1,
			)
			const next = rates[nextIndex]
			if (next === undefined || next === current) return
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
			if (e.key === '>') {
				stepRate(1)
				return
			}
			if (e.key === '<') {
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

	const togglePlay = React.useCallback(() => {
		const player = playerRef.current
		if (!player) return
		if (player.paused) void player.play().catch(() => {})
		else player.pause()
	}, [playerRef])

	// Mouse press-and-hold for 2x (fine pointers, video area only).
	const onShellPointerDown = React.useCallback(
		(e: React.PointerEvent) => {
			if (e.pointerType !== 'mouse' || e.button !== 0) return
			if (!isVideoAreaEvent(e.nativeEvent)) return
			if (mouseHoldTimerRef.current) clearTimeout(mouseHoldTimerRef.current)
			mouseHoldTimerRef.current = setTimeout(() => {
				mouseHoldTimerRef.current = null
				holdConsumedClickRef.current = true
				beginHoldSpeed()
			}, 500)
		},
		[beginHoldSpeed],
	)
	const onShellPointerUp = React.useCallback(
		(e: React.PointerEvent) => {
			armHideTimer()
			if (e.pointerType !== 'mouse') return
			if (mouseHoldTimerRef.current) {
				clearTimeout(mouseHoldTimerRef.current)
				mouseHoldTimerRef.current = null
			}
			if (holdPrevRateRef.current !== null) endHoldSpeed()
		},
		[armHideTimer, endHoldSpeed],
	)
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

	const clusterVisible = isCoarse && hasPlayed && (chromeVisible || paused)
	const surfaceActive = isCoarse && hasPlayed

	return (
		<div
			ref={shellRef}
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
						chromeVisible
							? 'bottom-24 left-0 right-0 top-14'
							: 'inset-0',
					)}
					style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
					onPointerDown={onSurfacePointerDown}
					onPointerMove={onSurfacePointerMove}
					onPointerUp={onSurfacePointerUp}
					onPointerCancel={onSurfacePointerCancel}
				/>
			)}
			{isCoarse && hasPlayed && (
				<div
					className={cn(
						'pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-8 transition-opacity duration-200 sm:gap-12',
						clusterVisible ? 'opacity-100' : 'opacity-0',
					)}
				>
					<ClusterButton
						label={`Back ${SEEK_SECONDS} seconds`}
						disabled={!clusterVisible}
						onAction={() => {
							seekBy(-SEEK_SECONDS)
							armHideTimer()
							void track('video_gesture', { gesture: 'center_cluster_seek' })
						}}
					>
						<RotateCcw aria-hidden="true" className="h-7 w-7" />
						<span
							aria-hidden="true"
							className="absolute text-[10px] font-semibold"
						>
							{SEEK_SECONDS}
						</span>
					</ClusterButton>
					<ClusterButton
						big
						label={paused ? 'Play' : 'Pause'}
						disabled={!clusterVisible}
						onAction={() => {
							togglePlay()
							armHideTimer()
							void track('video_gesture', { gesture: 'center_cluster_play' })
						}}
					>
						{paused ? (
							<Play
								aria-hidden="true"
								className="ml-1 h-9 w-9 fill-current"
							/>
						) : (
							<Pause aria-hidden="true" className="h-9 w-9 fill-current" />
						)}
					</ClusterButton>
					<ClusterButton
						label={`Forward ${SEEK_SECONDS} seconds`}
						disabled={!clusterVisible}
						onAction={() => {
							seekBy(SEEK_SECONDS)
							armHideTimer()
							void track('video_gesture', { gesture: 'center_cluster_seek' })
						}}
					>
						<RotateCw aria-hidden="true" className="h-7 w-7" />
						<span
							aria-hidden="true"
							className="absolute text-[10px] font-semibold"
						>
							{SEEK_SECONDS}
						</span>
					</ClusterButton>
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
							className="rounded-full bg-black/70 px-3 py-1 text-sm font-medium text-white"
						>
							{holdActive ? '2x ❯❯' : toast?.text}
						</motion.div>
					</div>
				)}
			</AnimatePresence>
		</div>
	)
}

function ClusterButton({
	label,
	big,
	disabled,
	onAction,
	children,
}: {
	label: string
	big?: boolean
	disabled?: boolean
	onAction: () => void
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			aria-label={label}
			tabIndex={disabled ? -1 : 0}
			className={cn(
				'touch-manipulation relative flex items-center justify-center rounded-full bg-black/60 text-white transition-transform active:scale-95',
				big ? 'h-[72px] w-[72px]' : 'h-14 w-14',
				disabled ? 'pointer-events-none' : 'pointer-events-auto',
			)}
			onClick={onAction}
		>
			{children}
		</button>
	)
}
