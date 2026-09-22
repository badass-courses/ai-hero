'use client'

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import type { AnalyticsRange } from '@/lib/analytics'
import type {
	DashboardSection,
	DashboardSectionData,
} from '@/lib/analytics/dashboard-contract'
import {
	DASHBOARD_SECTIONS,
	createEmptyDashboardData,
	isCurrentDashboardResponse,
	mergeDashboardSection,
} from '@/lib/analytics/dashboard-contract'

import { OmnibusDashboard, type DashboardData } from './omnibus-dashboard'
import { AnalyticsAgentApiCard } from './analytics-agent-api-card'
import {
	TrafficBreakdownPanel,
	type TrafficOverviewWithBreakdowns,
} from './traffic-breakdown-panel'

const SECTION_TIMEOUT_MS = 15_000
const SECTION_CONCURRENCY = 2

const SECTION_LABELS: Record<DashboardSection, string> = {
	summary: 'revenue',
	revenue: 'revenue details',
	attribution: 'attribution',
	shortlinks: 'shortlinks',
	traffic: 'traffic',
	mux: 'video',
	surveys: 'surveys',
	'value-paths': 'value paths',
}

type SectionState =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'ready' }
	| { status: 'failed'; message: string }

type SectionStates = Record<DashboardSection, SectionState>

function initialSectionStates(): SectionStates {
	return Object.fromEntries(
		DASHBOARD_SECTIONS.map((section) => [section, { status: 'idle' }]),
	) as SectionStates
}

function parseRange(raw: string | null, fallback: AnalyticsRange): AnalyticsRange {
	return raw &&
		(['24h', '7d', '30d', '90d', 'all'] as string[]).includes(raw)
		? (raw as AnalyticsRange)
		: fallback
}

function safeErrorMessage(error: unknown) {
	if (error instanceof Error && error.name === 'AbortError') {
		return 'This request timed out. Try again.'
	}
	return error instanceof Error && error.message
		? error.message
		: 'This section is temporarily unavailable.'
}

async function readSectionResponse(response: Response) {
	const body = (await response.json().catch(() => null)) as
		| {
				ok?: boolean
				error?: { message?: string }
				section?: string
				range?: string
				data?: unknown
			}
		| null
	if (!response.ok || !body?.ok || !body.data) {
		throw new Error(
			body?.error?.message ?? 'This analytics section is temporarily unavailable.',
		)
	}
	return body
}

export function ProgressiveAnalyticsDashboard({
	initialRange,
}: {
	initialRange: AnalyticsRange
}) {
	const searchParams = useSearchParams()
	const range = parseRange(searchParams.get('range'), initialRange)
	const [data, setData] = useState<DashboardData>(createEmptyDashboardData)
	const [traffic180d, setTraffic180d] =
		useState<TrafficOverviewWithBreakdowns | null>(null)
	const [sectionStates, setSectionStates] = useState<SectionStates>(
		initialSectionStates,
	)
	const generationRef = useRef(0)
	const activeRangeRef = useRef(range)
	const controllersRef = useRef(new Map<DashboardSection, AbortController>())

	useEffect(() => {
		const generation = generationRef.current + 1
		generationRef.current = generation
		activeRangeRef.current = range
		for (const controller of controllersRef.current.values()) {
			controller.abort()
		}
		controllersRef.current.clear()
		setData(createEmptyDashboardData())
		setTraffic180d(null)
		setSectionStates({
			...initialSectionStates(),
			summary: { status: 'loading' },
		})

		const isCurrent = () =>
			isCurrentDashboardResponse({
				responseRange: range,
				activeRange: activeRangeRef.current,
				responseGeneration: generation,
				activeGeneration: generationRef.current,
			})

		const runSection = async (section: DashboardSection) => {
			if (!isCurrent()) return false
			const controller = new AbortController()
			controllersRef.current.get(section)?.abort()
			controllersRef.current.set(section, controller)
			setSectionStates((current) => ({
				...current,
				[section]: { status: 'loading' },
			}))
			const timeout = setTimeout(
				() => controller.abort(),
				SECTION_TIMEOUT_MS,
			)

			try {
				const response = await fetch(
					`/api/analytics/dashboard?section=${encodeURIComponent(section)}&range=${encodeURIComponent(range)}`,
					{ signal: controller.signal, cache: 'no-store' },
				)
				const body = await readSectionResponse(response)
				if (
					!isCurrent() ||
					!isCurrentDashboardResponse({
						responseRange: body.range ?? '',
						activeRange: range,
						responseGeneration: generation,
						activeGeneration: generationRef.current,
					}) ||
					body.section !== section
				) {
					return false
				}

				const sectionData = body.data as DashboardSectionData[typeof section]
				setData((current) =>
					mergeDashboardSection(current, section, sectionData),
				)
				if (section === 'traffic') {
					setTraffic180d(
						(sectionData as DashboardSectionData['traffic']).traffic180d as TrafficOverviewWithBreakdowns,
					)
				}
				setSectionStates((current) => ({
					...current,
					[section]: { status: 'ready' },
				}))
				return true
			} catch (error) {
				if (!isCurrent()) return false
				setSectionStates((current) => ({
					...current,
					[section]: {
						status: 'failed',
						message: safeErrorMessage(error),
					},
				}))
				return false
			} finally {
				clearTimeout(timeout)
				if (controllersRef.current.get(section) === controller) {
					controllersRef.current.delete(section)
				}
			}
		}

		const runOptionalSections = async () => {
			const queue = DASHBOARD_SECTIONS.slice(1)
			const worker = async () => {
				while (queue.length > 0 && isCurrent()) {
					const section = queue.shift()
					if (!section) return
					await runSection(section)
				}
			}
		await Promise.all(
			Array.from(
				{ length: Math.min(SECTION_CONCURRENCY, queue.length) },
				() => worker(),
			),
		)
		}

		void (async () => {
			await runSection('summary')
			await runOptionalSections()
		})()

		return () => {
			generationRef.current += 1
			for (const controller of controllersRef.current.values()) {
				controller.abort()
			}
			controllersRef.current.clear()
		}
	}, [range])

	const retrySection = (section: DashboardSection) => {
		const generation = generationRef.current
		const requestedRange = activeRangeRef.current
		const controller = new AbortController()
		controllersRef.current.get(section)?.abort()
		controllersRef.current.set(section, controller)
		setSectionStates((current) => ({
			...current,
			[section]: { status: 'loading' },
		}))
		const timeout = setTimeout(() => controller.abort(), SECTION_TIMEOUT_MS)

		void (async () => {
			try {
				const response = await fetch(
					`/api/analytics/dashboard?section=${encodeURIComponent(section)}&range=${encodeURIComponent(requestedRange)}`,
					{ signal: controller.signal, cache: 'no-store' },
				)
				const body = await readSectionResponse(response)
				if (
					!isCurrentDashboardResponse({
						responseRange: body.range ?? '',
						activeRange: activeRangeRef.current,
						responseGeneration: generation,
						activeGeneration: generationRef.current,
					}) ||
					body.section !== section
				) {
					return
				}
				const sectionData = body.data as DashboardSectionData[typeof section]
				setData((current) =>
					mergeDashboardSection(current, section, sectionData),
				)
				if (section === 'traffic') {
					setTraffic180d(
						(sectionData as DashboardSectionData['traffic']).traffic180d as TrafficOverviewWithBreakdowns,
					)
				}
				setSectionStates((current) => ({
					...current,
					[section]: { status: 'ready' },
				}))
			} catch (error) {
				if (generation !== generationRef.current) return
				setSectionStates((current) => ({
					...current,
					[section]: { status: 'failed', message: safeErrorMessage(error) },
				}))
			} finally {
				clearTimeout(timeout)
				if (controllersRef.current.get(section) === controller) {
					controllersRef.current.delete(section)
				}
			}
		})()
	}

	const activeStatuses = DASHBOARD_SECTIONS.filter(
		(section) => sectionStates[section].status === 'loading' || sectionStates[section].status === 'failed',
	)

	return (
		<div className="flex flex-col gap-5 lg:gap-7">
			{activeStatuses.length > 0 && (
				<div className="flex flex-col gap-2" aria-live="polite">
					{activeStatuses.map((section) => {
						const state = sectionStates[section]
						return (
							<div
								key={section}
								className="border-border/50 bg-card/50 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-xs"
							>
								<span className="text-muted-foreground">
									{state.status === 'loading'
										? `Loading ${SECTION_LABELS[section]}…`
										: `${SECTION_LABELS[section]} failed: ${state.status === 'failed' ? state.message : 'This section is temporarily unavailable.'}`}
								</span>
								{state.status === 'failed' && (
									<button
										type="button"
										onClick={() => retrySection(section)}
										className="text-foreground shrink-0 font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
									>
										Retry
									</button>
								)}
							</div>
						)
					})}
				</div>
			)}

			<OmnibusDashboard
				appName="AI Hero"
				data={data}
				initialRange={range}
				surveyDrilldownHref="/admin/analytics/surveys"
				agentApiCard={<AnalyticsAgentApiCard />}
			/>
			<TrafficBreakdownPanel traffic={traffic180d} />
		</div>
	)
}
