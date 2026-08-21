'use client'

import * as React from 'react'
import Globe, { type GlobeMethods } from 'react-globe.gl'

import {
	DEFAULT_GLOBE_ALTITUDE,
	IDLE_RESUME_MS,
	LOOK_AT_MS,
	configureSalesGlobeControls,
	povAfterViewportKey,
	type GlobeOrbitControls,
} from './sales-globe-navigation'

export type GlobeHit = Readonly<{
	id: string
	lat: number
	lng: number
	isTeam: boolean
}>

const EARTH_NIGHT_URL = '/admin-globe/earth-night.jpg'
const EARTH_BUMP_URL = '/admin-globe/earth-topology.png'

function isTeamHit(value: object): boolean {
	return 'isTeam' in value && value.isTeam === true
}

const ringColor = (ring: object) =>
	isTeamHit(ring) ? ['#ef4444', '#f59e0b00'] : ['#22c55e', '#22c55e00']
const ringMaxRadius = (ring: object) => (isTeamHit(ring) ? 8 : 5)
const ringPropagationSpeed = (ring: object) => (isTeamHit(ring) ? 5 : 3)
const pointAltitude = (point: object) => (isTeamHit(point) ? 0.08 : 0.04)
const pointRadius = (point: object) => (isTeamHit(point) ? 0.45 : 0.25)
const pointColor = (point: object) => (isTeamHit(point) ? '#f97316' : '#22c55e')

/**
 * Night-earth globe with a graticule mesh, auto-rotate, and 3ds Max-style orbit/zoom.
 */
export function SalesGlobeCanvas({
	points,
	rings,
	focusHit,
	lookAtMs = LOOK_AT_MS,
	holdAutoRotate = false,
}: {
	points: readonly GlobeHit[]
	rings: readonly GlobeHit[]
	focusHit: GlobeHit | null
	lookAtMs?: number
	holdAutoRotate?: boolean
}) {
	const containerRef = React.useRef<HTMLDivElement>(null)
	const globeRef = React.useRef<GlobeMethods | undefined>(undefined)
	const userDrivingRef = React.useRef(false)
	const idleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
	const seenFocusIdRef = React.useRef<string | null>(null)
	const holdAutoRotateRef = React.useRef(holdAutoRotate)
	holdAutoRotateRef.current = holdAutoRotate
	const [size, setSize] = React.useState({ width: 0, height: 0 })

	const clearIdleTimer = React.useCallback(() => {
		if (idleTimerRef.current) {
			clearTimeout(idleTimerRef.current)
			idleTimerRef.current = null
		}
	}, [])

	const setAutoRotate = React.useCallback((enabled: boolean) => {
		const controls = globeRef.current?.controls() as
			| GlobeOrbitControls
			| undefined
		if (controls) controls.autoRotate = enabled
	}, [])

	React.useEffect(() => {
		const container = containerRef.current
		if (!container) return

		const measure = () => {
			setSize({
				width: container.clientWidth,
				height: container.clientHeight,
			})
		}
		measure()

		const observer = new ResizeObserver(measure)
		observer.observe(container)
		return () => observer.disconnect()
	}, [])

	React.useEffect(() => {
		const syncAnimation = () => {
			if (document.hidden) {
				globeRef.current?.pauseAnimation()
			} else {
				globeRef.current?.resumeAnimation()
			}
		}

		syncAnimation()
		document.addEventListener('visibilitychange', syncAnimation)
		return () => document.removeEventListener('visibilitychange', syncAnimation)
	}, [])

	React.useEffect(() => {
		return () => clearIdleTimer()
	}, [clearIdleTimer])

	const handleGlobeReady = React.useCallback(() => {
		const globe = globeRef.current
		if (!globe) return

		const controls = globe.controls() as GlobeOrbitControls
		configureSalesGlobeControls(controls)
		if (holdAutoRotateRef.current) controls.autoRotate = false

		const onStart = () => {
			userDrivingRef.current = true
			clearIdleTimer()
			controls.autoRotate = false
		}
		const onEnd = () => {
			userDrivingRef.current = false
			clearIdleTimer()
			if (holdAutoRotateRef.current) return
			idleTimerRef.current = setTimeout(() => {
				if (!userDrivingRef.current && !holdAutoRotateRef.current) {
					controls.autoRotate = true
				}
			}, IDLE_RESUME_MS)
		}

		controls.addEventListener('start', onStart)
		controls.addEventListener('end', onEnd)
		globe.pointOfView({ altitude: DEFAULT_GLOBE_ALTITUDE })
	}, [clearIdleTimer])

	React.useEffect(() => {
		if (holdAutoRotate) setAutoRotate(false)
	}, [holdAutoRotate, setAutoRotate])

	React.useEffect(() => {
		if (!focusHit) return
		if (seenFocusIdRef.current === null) {
			seenFocusIdRef.current = focusHit.id
			return
		}
		if (seenFocusIdRef.current === focusHit.id) return
		seenFocusIdRef.current = focusHit.id

		const globe = globeRef.current
		if (!globe || userDrivingRef.current) return

		const current = globe.pointOfView()
		setAutoRotate(!holdAutoRotate)
		globe.pointOfView(
			{
				lat: focusHit.lat,
				lng: focusHit.lng,
				altitude: current.altitude || DEFAULT_GLOBE_ALTITUDE,
			},
			lookAtMs,
		)
	}, [focusHit, holdAutoRotate, lookAtMs, setAutoRotate])

	const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const globe = globeRef.current
		if (!globe) return
		const next = povAfterViewportKey(globe.pointOfView(), event.key)
		if (!next) return
		event.preventDefault()
		userDrivingRef.current = true
		setAutoRotate(false)
		globe.pointOfView(next, event.key === 'Z' || event.key === 'z' ? 400 : 0)
	}

	React.useEffect(() => {
		const container = containerRef.current
		if (!container) return
		const onWheel = (event: WheelEvent) => {
			event.preventDefault()
		}
		container.addEventListener('wheel', onWheel, {
			passive: false,
			capture: true,
		})
		return () =>
			container.removeEventListener('wheel', onWheel, { capture: true })
	}, [])

	return (
		<div
			ref={containerRef}
			tabIndex={0}
			onKeyDown={handleKeyDown}
			className="h-full w-full cursor-grab outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/70 active:cursor-grabbing"
			aria-label="Sales globe. Drag to orbit. Scroll to zoom. Z resets distance. Arrow keys orbit."
		>
			{size.width > 0 && size.height > 0 ? (
				<Globe
					ref={globeRef}
					width={size.width}
					height={size.height}
					backgroundColor="rgba(0,0,0,0)"
					globeImageUrl={EARTH_NIGHT_URL}
					bumpImageUrl={EARTH_BUMP_URL}
					showAtmosphere
					showGraticules
					atmosphereColor="#22d3ee"
					atmosphereAltitude={0.22}
					onGlobeReady={handleGlobeReady}
					ringsData={[...rings]}
					ringLat="lat"
					ringLng="lng"
					ringColor={ringColor}
					ringMaxRadius={ringMaxRadius}
					ringPropagationSpeed={ringPropagationSpeed}
					ringRepeatPeriod={0}
					pointsData={[...points]}
					pointLat="lat"
					pointLng="lng"
					pointAltitude={pointAltitude}
					pointRadius={pointRadius}
					pointColor={pointColor}
					pointsMerge
				/>
			) : null}
		</div>
	)
}
