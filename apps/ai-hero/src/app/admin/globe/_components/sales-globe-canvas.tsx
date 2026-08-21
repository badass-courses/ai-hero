'use client'

import * as React from 'react'
import Globe, { type GlobeMethods } from 'react-globe.gl'

export type GlobeHit = Readonly<{
	id: string
	lat: number
	lng: number
	isTeam: boolean
}>

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

export function SalesGlobeCanvas({
	points,
	rings,
}: {
	points: readonly GlobeHit[]
	rings: readonly GlobeHit[]
}) {
	const containerRef = React.useRef<HTMLDivElement>(null)
	const globeRef = React.useRef<GlobeMethods | undefined>(undefined)
	const [size, setSize] = React.useState({ width: 0, height: 0 })

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

	return (
		<div ref={containerRef} className="h-full w-full">
			{size.width > 0 && size.height > 0 ? (
				<Globe
					ref={globeRef}
					width={size.width}
					height={size.height}
					backgroundColor="rgba(0,0,0,0)"
					atmosphereColor="#38bdf8"
					atmosphereAltitude={0.18}
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
