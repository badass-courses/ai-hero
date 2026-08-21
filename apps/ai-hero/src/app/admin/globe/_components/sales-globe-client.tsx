'use client'

import * as React from 'react'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import {
	SalesGlobePurchasesResponseSchema,
	LIVE_PURCHASE_LIMIT,
	MAX_PURCHASE_LIMIT,
	type AdminGlobeProductOption,
	type SerializedPurchaseTickerHit,
} from '@/lib/admin-sales-globe-contract'
import { Button } from '@/components/ui/button'
import { Globe2, Pause, Play, Radio, User, Volume2, VolumeX } from 'lucide-react'

import { Gravatar } from '@coursebuilder/ui'

import countryCentroids from '../_data/country-centroids.json'
import type { GlobeHit } from './sales-globe-canvas'
import {
	DEFAULT_REPLAY_SPEED,
	REPLAY_SPEEDS,
	mergePendingHits,
	nextHitGapMs,
	oldestFirst,
	replayHitGapMs,
	type ReplaySpeed,
} from './sales-globe-feed'

const SalesGlobeCanvas = dynamic(
	() =>
		import('./sales-globe-canvas').then((module) => module.SalesGlobeCanvas),
	{
		ssr: false,
		loading: () => <div className="bg-muted h-full w-full animate-pulse" />,
	},
)

const MUTE_KEY = 'aih-admin-sales-globe-muted'
const POLL_INTERVAL_MS = 3_000
const RING_LIFETIME_MS = 2_500
const MAX_HITS = MAX_PURCHASE_LIMIT
const money = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
})
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' })

type AudioState = 'suspended' | 'running'
type BoardMode = 'live' | 'replay' | 'history'

type CountryLocation = Readonly<{
	lat: number
	lng: number
}>

function countryToLatLng(
	code: string | null | undefined,
): CountryLocation | null {
	const normalized = code?.trim().toUpperCase()
	if (!normalized || !(normalized in countryCentroids)) return null

	// SAFETY: the `in` check proves this normalized key exists in the vendored map.
	const value = countryCentroids[normalized as keyof typeof countryCentroids]
	const lat = value[0]
	const lng = value[1]
	return typeof lat === 'number' && typeof lng === 'number'
		? { lat, lng }
		: null
}

function toGlobeHit(hit: SerializedPurchaseTickerHit): GlobeHit | null {
	const location = countryToLatLng(hit.country)
	return location ? { id: hit.id, ...location, isTeam: hit.isTeam } : null
}

function countryFlag(country: string | null): string {
	if (!country) return '🌐'
	return String.fromCodePoint(
		...country
			.toUpperCase()
			.split('')
			.map((character) => 127397 + character.charCodeAt(0)),
	)
}

function countryLabel(country: string | null): string {
	return country ? (regionNames.of(country) ?? country) : 'Unknown'
}

export function SalesGlobeClient({
	initialPurchases,
	products: catalogProducts,
}: {
	initialPurchases: readonly SerializedPurchaseTickerHit[]
	products: readonly AdminGlobeProductOption[]
}) {
	const [hits, setHits] = React.useState(() =>
		initialPurchases.slice(0, MAX_HITS),
	)
	const [rings, setRings] = React.useState<GlobeHit[]>([])
	const [pinnedProductId, setPinnedProductId] = React.useState('all')
	const [muted, setMuted] = React.useState(false)
	const [audioState, setAudioState] = React.useState<AudioState>('suspended')
	const [pollFailed, setPollFailed] = React.useState(false)
	const [pendingCount, setPendingCount] = React.useState(0)
	const [mode, setMode] = React.useState<BoardMode>('live')
	const [paused, setPaused] = React.useState(false)
	const [speed, setSpeed] = React.useState<ReplaySpeed>(DEFAULT_REPLAY_SPEED)
	const [historyLoading, setHistoryLoading] = React.useState(false)
	const [replayProgress, setReplayProgress] = React.useState({
		played: 0,
		total: 0,
	})
	const seenIdsRef = React.useRef(
		new Set(initialPurchases.map((purchase) => purchase.id)),
	)
	const inFlightRef = React.useRef(false)
	const activeRequestRef = React.useRef<AbortController | null>(null)
	const historyRequestRef = React.useRef<AbortController | null>(null)
	const ringTimersRef = React.useRef(new Set<ReturnType<typeof setTimeout>>())
	const pendingHitsRef = React.useRef<SerializedPurchaseTickerHit[]>([])
	const pumpTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
	const playNextPendingRef = React.useRef<() => void>(() => undefined)
	const audioContextRef = React.useRef<AudioContext | null>(null)
	const mutedRef = React.useRef(false)
	const modeRef = React.useRef<BoardMode>('live')
	const speedRef = React.useRef<ReplaySpeed>(DEFAULT_REPLAY_SPEED)
	const pausedRef = React.useRef(false)

	const rememberMute = React.useCallback((nextMuted: boolean) => {
		mutedRef.current = nextMuted
		setMuted(nextMuted)
		window.localStorage.setItem(MUTE_KEY, String(nextMuted))
	}, [])

	const ensureAudio = React.useCallback(async () => {
		const context =
			audioContextRef.current ??
			new window.AudioContext({ latencyHint: 'interactive' })
		audioContextRef.current = context
		if (context.state === 'suspended') {
			await context.resume()
		}
		const running = context.state === 'running'
		setAudioState(running ? 'running' : 'suspended')
		return running
	}, [])

	const playHit = React.useCallback((isTeam: boolean) => {
		const context = audioContextRef.current
		if (mutedRef.current || context?.state !== 'running') return

		const playTone = ({
			frequency,
			startOffset,
			duration,
			volume,
		}: {
			frequency: number
			startOffset: number
			duration: number
			volume: number
		}) => {
			const startsAt = context.currentTime + startOffset
			const oscillator = context.createOscillator()
			const gain = context.createGain()
			oscillator.type = 'sine'
			oscillator.frequency.setValueAtTime(frequency, startsAt)
			gain.gain.setValueAtTime(0.0001, startsAt)
			gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.015)
			gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration)
			oscillator.connect(gain)
			gain.connect(context.destination)
			oscillator.start(startsAt)
			oscillator.stop(startsAt + duration + 0.02)
		}

		playTone({
			frequency: isTeam ? 220 : 520,
			startOffset: 0,
			duration: isTeam ? 0.24 : 0.15,
			volume: isTeam ? 0.22 : 0.12,
		})
		if (isTeam) {
			playTone({
				frequency: 440,
				startOffset: 0.09,
				duration: 0.22,
				volume: 0.18,
			})
		}
	}, [])

	const addLiveHit = React.useCallback(
		(hit: SerializedPurchaseTickerHit) => {
			setHits((current) =>
				[hit, ...current.filter((candidate) => candidate.id !== hit.id)].slice(
					0,
					MAX_HITS,
				),
			)

			const globeHit = toGlobeHit(hit)
			if (globeHit) {
				setRings((current) => [globeHit, ...current])
				const timer = setTimeout(() => {
					setRings((current) => current.filter((ring) => ring.id !== hit.id))
					ringTimersRef.current.delete(timer)
				}, RING_LIFETIME_MS)
				ringTimersRef.current.add(timer)
			} else {
				console.warn('Sales globe hit has no known country coordinates', {
					purchaseId: hit.id,
					country: hit.country,
				})
			}
			playHit(hit.isTeam)
		},
		[playHit],
	)

	playNextPendingRef.current = () => {
		pumpTimerRef.current = null
		if (pausedRef.current) return
		const next = pendingHitsRef.current.shift()
		setPendingCount(pendingHitsRef.current.length)
		if (!next) {
			if (modeRef.current === 'replay') {
				modeRef.current = 'history'
				setMode('history')
			}
			return
		}
		addLiveHit(next)
		if (modeRef.current === 'replay') {
			setReplayProgress((current) => ({
				played: current.played + 1,
				total: current.total,
			}))
		}
		if (pendingHitsRef.current.length === 0) {
			if (modeRef.current === 'replay') {
				modeRef.current = 'history'
				setMode('history')
			}
			return
		}
		const gap =
			modeRef.current === 'replay'
				? replayHitGapMs(next.isTeam, speedRef.current)
				: nextHitGapMs(pendingHitsRef.current.length, next.isTeam)
		pumpTimerRef.current = setTimeout(() => {
			playNextPendingRef.current()
		}, gap)
	}

	const stopPump = React.useCallback(() => {
		if (pumpTimerRef.current) {
			clearTimeout(pumpTimerRef.current)
			pumpTimerRef.current = null
		}
		pendingHitsRef.current = []
		setPendingCount(0)
		pausedRef.current = false
		setPaused(false)
	}, [])

	const enqueueLiveHits = React.useCallback(
		(incoming: readonly SerializedPurchaseTickerHit[]) => {
			if (incoming.length === 0) return
			pendingHitsRef.current = mergePendingHits(
				pendingHitsRef.current,
				incoming,
			)
			setPendingCount(pendingHitsRef.current.length)
			if (pumpTimerRef.current || pausedRef.current) return
			playNextPendingRef.current()
		},
		[],
	)

	const poll = React.useCallback(
		async (options?: { replace?: boolean }) => {
			if (inFlightRef.current) return
			if (!options?.replace && modeRef.current !== 'live') return
			inFlightRef.current = true
			const controller = new AbortController()
			activeRequestRef.current = controller

			try {
				const response = await fetch(
					`/api/admin/globe/purchases?limit=${LIVE_PURCHASE_LIMIT}`,
					{
						cache: 'no-store',
						signal: controller.signal,
					},
				)
				if (!response.ok) {
					throw new Error(`Sales globe poll failed with ${response.status}`)
				}

				const payload: unknown = await response.json()
				const parsed = SalesGlobePurchasesResponseSchema.safeParse(payload)
				if (!parsed.success) {
					throw new Error('Sales globe poll returned an invalid payload')
				}

				if (options?.replace) {
					seenIdsRef.current = new Set(
						parsed.data.purchases.map((purchase) => purchase.id),
					)
					setHits(parsed.data.purchases.slice(0, MAX_HITS))
					setPollFailed(false)
					return
				}

				const unseen = parsed.data.purchases
					.filter((purchase) => !seenIdsRef.current.has(purchase.id))
					.sort(oldestFirst)
				for (const purchase of unseen) {
					seenIdsRef.current.add(purchase.id)
				}
				enqueueLiveHits(unseen)
				setPollFailed(false)
			} catch (error) {
				if (!(error instanceof DOMException && error.name === 'AbortError')) {
					console.error('Sales globe poll failed', error)
					setPollFailed(true)
				}
			} finally {
				if (activeRequestRef.current === controller) {
					activeRequestRef.current = null
					inFlightRef.current = false
				}
			}
		},
		[enqueueLiveHits],
	)

	const fetchHistory = React.useCallback(
		async (productId: string) => {
			historyRequestRef.current?.abort()
			const controller = new AbortController()
			historyRequestRef.current = controller
			const params = new URLSearchParams({
				limit: String(MAX_PURCHASE_LIMIT),
			})
			if (productId !== 'all') params.set('productId', productId)
			const response = await fetch(
				`/api/admin/globe/purchases?${params.toString()}`,
				{
					cache: 'no-store',
					signal: controller.signal,
				},
			)
			if (!response.ok) {
				throw new Error(`Sales globe history failed with ${response.status}`)
			}
			const payload: unknown = await response.json()
			const parsed = SalesGlobePurchasesResponseSchema.safeParse(payload)
			if (!parsed.success) {
				throw new Error('Sales globe history returned an invalid payload')
			}
			return parsed.data.purchases
		},
		[],
	)

	const showHistory = React.useCallback(async () => {
		setHistoryLoading(true)
		try {
			const purchases = await fetchHistory(pinnedProductId)
			stopPump()
			setRings([])
			setHits(purchases.slice(0, MAX_HITS))
			modeRef.current = 'history'
			setMode('history')
			setReplayProgress({
				played: purchases.length,
				total: purchases.length,
			})
			setPollFailed(false)
			void ensureAudio()
		} catch (error) {
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				console.error('Sales globe history failed', error)
				setPollFailed(true)
			}
		} finally {
			setHistoryLoading(false)
		}
	}, [ensureAudio, fetchHistory, pinnedProductId, stopPump])

	const startReplay = React.useCallback(async () => {
		setHistoryLoading(true)
		try {
			const purchases = await fetchHistory(pinnedProductId)
			stopPump()
			setRings([])
			setHits([])
			const chronological = [...purchases].sort(oldestFirst)
			pendingHitsRef.current = chronological
			setPendingCount(chronological.length)
			modeRef.current = 'replay'
			setMode('replay')
			setReplayProgress({ played: 0, total: chronological.length })
			setPollFailed(false)
			await ensureAudio()
			if (chronological.length === 0) {
				modeRef.current = 'history'
				setMode('history')
				return
			}
			playNextPendingRef.current()
		} catch (error) {
			if (!(error instanceof DOMException && error.name === 'AbortError')) {
				console.error('Sales globe replay failed', error)
				setPollFailed(true)
			}
		} finally {
			setHistoryLoading(false)
		}
	}, [ensureAudio, fetchHistory, pinnedProductId, stopPump])

	const pauseReplay = React.useCallback(() => {
		pausedRef.current = true
		setPaused(true)
		if (pumpTimerRef.current) {
			clearTimeout(pumpTimerRef.current)
			pumpTimerRef.current = null
		}
	}, [])

	const resumeReplay = React.useCallback(() => {
		if (modeRef.current !== 'replay') return
		pausedRef.current = false
		setPaused(false)
		if (!pumpTimerRef.current) playNextPendingRef.current()
	}, [])

	const returnToLive = React.useCallback(async () => {
		historyRequestRef.current?.abort()
		stopPump()
		setRings([])
		modeRef.current = 'live'
		setMode('live')
		setReplayProgress({ played: 0, total: 0 })
		activeRequestRef.current?.abort()
		inFlightRef.current = false
		await poll({ replace: true })
	}, [poll, stopPump])

	const changeSpeed = React.useCallback((nextSpeed: ReplaySpeed) => {
		speedRef.current = nextSpeed
		setSpeed(nextSpeed)
		if (
			modeRef.current !== 'replay' ||
			pausedRef.current ||
			!pumpTimerRef.current
		) {
			return
		}
		clearTimeout(pumpTimerRef.current)
		pumpTimerRef.current = setTimeout(() => {
			playNextPendingRef.current()
		}, replayHitGapMs(false, nextSpeed))
	}, [])

	React.useEffect(() => {
		const stored = window.localStorage.getItem(MUTE_KEY)
		if (stored === 'true') {
			mutedRef.current = true
			setMuted(true)
		}
	}, [])

	React.useEffect(() => {
		if (muted || audioState === 'running') return

		const arm = () => void ensureAudio()
		window.addEventListener('pointerdown', arm, { once: true })
		window.addEventListener('keydown', arm, { once: true })
		return () => {
			window.removeEventListener('pointerdown', arm)
			window.removeEventListener('keydown', arm)
		}
	}, [audioState, ensureAudio, muted])

	React.useEffect(() => {
		if (mode !== 'live') return
		const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
		const catchUp = () => {
			if (document.visibilityState === 'visible') void poll()
		}
		document.addEventListener('visibilitychange', catchUp)

		return () => {
			window.clearInterval(interval)
			document.removeEventListener('visibilitychange', catchUp)
			activeRequestRef.current?.abort()
		}
	}, [mode, poll])

	React.useEffect(
		() => () => {
			historyRequestRef.current?.abort()
			if (pumpTimerRef.current) {
				clearTimeout(pumpTimerRef.current)
				pumpTimerRef.current = null
			}
			for (const timer of ringTimersRef.current) clearTimeout(timer)
			ringTimersRef.current.clear()
			void audioContextRef.current?.close()
		},
		[],
	)

	const products = React.useMemo(() => {
		const byId = new Map<string, string>()
		for (const product of catalogProducts) byId.set(product.id, product.name)
		for (const hit of hits) byId.set(hit.productId, hit.productName)
		return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1]))
	}, [catalogProducts, hits])

	const visibleHits = React.useMemo(
		() =>
			mode === 'live' && pinnedProductId !== 'all'
				? hits.filter((hit) => hit.productId === pinnedProductId)
				: hits,
		[hits, mode, pinnedProductId],
	)
	const points = React.useMemo(
		() => visibleHits.flatMap((hit) => toGlobeHit(hit) ?? []),
		[visibleHits],
	)
	const visibleRings = React.useMemo(() => {
		if (mode !== 'live' || pinnedProductId === 'all') return rings
		const visibleIds = new Set(visibleHits.map((hit) => hit.id))
		return rings.filter((ring) => visibleIds.has(ring.id))
	}, [mode, pinnedProductId, rings, visibleHits])

	const handleSoundControl = async () => {
		if (muted) {
			rememberMute(false)
			await ensureAudio()
			return
		}
		if (audioState === 'running') {
			rememberMute(true)
			return
		}
		await ensureAudio()
	}

	const soundLabel = muted
		? 'Unmute'
		: audioState === 'running'
			? 'Mute'
			: 'Arm sound'

	const feedStatus = pollFailed
		? { className: 'text-amber-500', label: 'retrying' }
		: mode === 'replay'
			? {
					className: 'text-cyan-400',
					label: paused
						? `paused ${replayProgress.played}/${replayProgress.total}`
						: `replay ${replayProgress.played}/${replayProgress.total}`,
				}
			: mode === 'history'
				? { className: 'text-cyan-400', label: 'history' }
				: { className: 'text-emerald-500', label: 'live' }

	return (
		<main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-4 px-3 py-4 sm:px-4">
			<header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div>
					<div className="text-muted-foreground flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em]">
						<Radio className="size-3.5 text-emerald-500" />
						Paid purchase feed
						<span className={feedStatus.className}>{feedStatus.label}</span>
						{mode === 'live' && pendingCount > 0 ? (
							<span className="text-cyan-400">{pendingCount} queued</span>
						) : null}
					</div>
					<h1 className="mt-1 text-2xl font-semibold tracking-tight">
						Sales situation board
					</h1>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<label className="text-muted-foreground flex items-center gap-2 text-sm">
						<span>Product</span>
						<select
							value={pinnedProductId}
							onChange={(event) => setPinnedProductId(event.target.value)}
							className="border-input bg-background h-9 max-w-60 rounded-md border px-3 text-sm"
						>
							<option value="all">All products</option>
							{products.map(([id, name]) => (
								<option key={id} value={id}>
									{name}
								</option>
							))}
						</select>
					</label>
					<Button
						variant="outline"
						size="sm"
						disabled={historyLoading}
						onClick={() => void showHistory()}
					>
						Show
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={historyLoading}
						onClick={() => void startReplay()}
					>
						<Play />
						Replay
					</Button>
					{mode === 'replay' ? (
						<Button
							variant="outline"
							size="sm"
							onClick={paused ? resumeReplay : pauseReplay}
						>
							{paused ? <Play /> : <Pause />}
							{paused ? 'Resume' : 'Pause'}
						</Button>
					) : null}
					{mode !== 'live' ? (
						<Button
							variant="outline"
							size="sm"
							onClick={() => void returnToLive()}
						>
							Live
						</Button>
					) : null}
					<label className="text-muted-foreground flex items-center gap-2 text-sm">
						<span>Speed</span>
						<select
							value={speed}
							onChange={(event) =>
								changeSpeed(Number(event.target.value) as ReplaySpeed)
							}
							className="border-input bg-background h-9 rounded-md border px-3 text-sm"
						>
							{REPLAY_SPEEDS.map((value) => (
								<option key={value} value={value}>
									{value}x
								</option>
							))}
						</select>
					</label>
					<Button
						variant="outline"
						size="sm"
						onClick={() => void handleSoundControl()}
						aria-label={soundLabel}
					>
						{muted ? <VolumeX /> : <Volume2 />}
						{soundLabel}
					</Button>
				</div>
			</header>

			<section className="relative h-[clamp(360px,62dvh,760px)] min-w-0 overflow-hidden rounded-lg border bg-[radial-gradient(circle_at_center,rgba(14,116,144,0.18),transparent_62%)]">
				<SalesGlobeCanvas
					points={points}
					rings={visibleRings}
					focusHit={visibleRings[0] ?? null}
				/>
				<div className="pointer-events-none absolute left-3 top-3 rounded border border-white/10 bg-black/55 px-2 py-1 font-mono text-xs text-white/75 backdrop-blur">
					{mode === 'replay'
						? `${replayProgress.played} / ${replayProgress.total}`
						: `${visibleHits.length} paid hit${visibleHits.length === 1 ? '' : 's'}`}
				</div>
			</section>

			<section
				className="border-border bg-background max-h-[28dvh] min-h-40 overflow-y-auto rounded-lg border font-mono"
				aria-label="Recent purchases"
				aria-live="polite"
			>
				<div className="border-border text-muted-foreground sticky top-0 z-10 flex items-center justify-between border-b bg-inherit px-3 py-2 text-xs uppercase tracking-[0.16em]">
					<span>Recent purchases</span>
					<span>Newest first</span>
				</div>
				{visibleHits.length === 0 ? (
					<div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2 p-6 text-sm">
						<Globe2 className="size-4" />
						{hits.length === 0
							? mode === 'replay'
								? 'Playing history.'
								: 'No paid purchases yet.'
							: 'No recent purchases for this product.'}
					</div>
				) : (
					<ul className="divide-border divide-y">
						{visibleHits.map((hit) => (
							<li
								key={hit.id}
								className="grid gap-3 px-3 py-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
							>
								<div className="flex items-center gap-2">
									{hit.userImage ? (
										<Image
											src={hit.userImage}
											alt={hit.userName ?? ''}
											width={32}
											height={32}
											className="size-8 rounded-full object-cover"
										/>
									) : hit.userEmail ? (
										<Gravatar
											email={hit.userEmail}
											default="mp"
											className="size-8 rounded-full"
										/>
									) : (
										<span className="bg-muted flex size-8 items-center justify-center rounded-full">
											<User className="size-4" />
										</span>
									)}
									<span className="text-xl" title={countryLabel(hit.country)}>
										{countryFlag(hit.country)}
									</span>
								</div>
								<div className="min-w-0">
									<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
										<strong className="truncate font-semibold">
											{hit.userName ?? 'Someone'}
										</strong>
										<span className="text-muted-foreground truncate text-xs">
											{hit.userEmail ?? 'email unavailable'}
										</span>
										<span className="text-muted-foreground text-xs">
											{countryLabel(hit.country)}
										</span>
									</div>
									<div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
										<span>{hit.productName}</span>
										{hit.seats ? <span>{hit.seats} seats</span> : null}
										{hit.isTeam ? (
											<strong className="text-orange-500">🥤 OH YEAH</strong>
										) : null}
									</div>
								</div>
								<div className="flex items-baseline justify-between gap-3 sm:block sm:text-right">
									<strong
										className={
											hit.isTeam ? 'text-orange-500' : 'text-emerald-500'
										}
									>
										{money.format(hit.amount)}
									</strong>
									<time
										dateTime={hit.createdAt}
										className="text-muted-foreground block text-[11px]"
									>
										{new Date(hit.createdAt).toLocaleTimeString([], {
											hour: '2-digit',
											minute: '2-digit',
											second: '2-digit',
										})}
									</time>
								</div>
							</li>
						))}
					</ul>
				)}
			</section>
		</main>
	)
}
