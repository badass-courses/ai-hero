import { NextRequest, NextResponse } from 'next/server'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import {
	DASHBOARD_SECTIONS,
	loadDashboardSection,
} from '@/lib/analytics/dashboard-sections'
import type { AnalyticsRange } from '@/lib/analytics'
import type { DashboardSection } from '@/lib/analytics/dashboard-contract'

const NO_STORE_HEADERS = {
	'Cache-Control': 'private, no-store',
}

const VALID_RANGES = new Set<AnalyticsRange>([
	'24h',
	'7d',
	'30d',
	'90d',
	'all',
])

function isDashboardSection(value: string | null): value is DashboardSection {
	return Boolean(value && DASHBOARD_SECTIONS.includes(value as DashboardSection))
}

function parseRange(value: string | null): AnalyticsRange | null {
	return value && VALID_RANGES.has(value as AnalyticsRange)
		? (value as AnalyticsRange)
		: null
}

function json(body: unknown, status: number) {
	return NextResponse.json(body, {
		status,
		headers: NO_STORE_HEADERS,
	})
}

export async function GET(request: NextRequest) {
	const { ability, session } = await getServerAuthSession()
	const canAccess =
		Boolean(session?.user?.id) &&
		(ability.can('manage', 'all') || ability.can('view', 'Analytics'))

	if (!canAccess) {
		return json({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Unauthorized' } }, 401)
	}

	const params = new URL(request.url).searchParams
	const rawSection = params.get('section')
	const rawRange = params.get('range')
	const range = parseRange(rawRange)

	if (!isDashboardSection(rawSection) || !range) {
		return json(
			{
				ok: false,
				error: {
					code: 'INVALID_SECTION_OR_RANGE',
					message: 'Choose a supported analytics section and range.',
				},
			},
			400,
		)
	}

	try {
		const data = await loadDashboardSection(rawSection, range, {
			signal: request.signal,
		})
		return json({ ok: true, section: rawSection, range, data }, 200)
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return json(
				{
					ok: false,
					section: rawSection,
					range,
					error: {
						code: 'REQUEST_ABORTED',
						message: 'The analytics request was cancelled.',
					},
				},
				499,
			)
		}

		const code =
			error &&
			typeof error === 'object' &&
			'code' in error &&
			typeof error.code === 'string'
				? error.code
				: 'SECTION_QUERY_FAILED'
		void log.error('api.analytics.dashboard.section-failed', {
			userId: session?.user?.id ?? null,
			section: rawSection,
			range,
			code,
			errorName: error instanceof Error ? error.name : 'UnknownError',
		})

		return json(
			{
				ok: false,
				section: rawSection,
				range,
				error: {
					code: 'SECTION_UNAVAILABLE',
					message: 'This analytics section is temporarily unavailable.',
				},
			},
			503,
		)
	}
}
