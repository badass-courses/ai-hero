import { notFound } from 'next/navigation'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'

import { ProgressiveAnalyticsDashboard } from './_components/progressive-dashboard'

const VALID_RANGES = new Set(['24h', '7d', '30d', '90d', 'all'])
type AnalyticsRange = '24h' | '7d' | '30d' | '90d' | 'all'

function parseRange(raw?: string): AnalyticsRange {
	if (raw && VALID_RANGES.has(raw)) return raw as AnalyticsRange
	return '30d'
}

export default async function AnalyticsPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
	const { ability, session } = await getServerAuthSession()
	const canManage = ability.can('manage', 'all')
	const canViewAnalytics = ability.can('view', 'Analytics')

	if (!canManage && !canViewAnalytics) {
		await log.warn('admin.analytics.access-denied', {
			userId: session?.user?.id ?? null,
			email: (session?.user as any)?.email ?? null,
			roles: (session?.user as any)?.roles?.map((r: any) => r.name) ?? [],
			canManage,
			canViewAnalytics,
			authenticated: !!session?.user,
			abilityRules: JSON.stringify(ability.rules),
		})
		notFound()
	}

	const params = await searchParams
	const range = parseRange(
		Array.isArray(params.range) ? params.range[0] : params.range,
	)

	void log.info('admin.analytics.page-load', {
		userId: session?.user?.id ?? null,
		email: (session?.user as any)?.email ?? null,
		roles: (session?.user as any)?.roles?.map((r: any) => r.name) ?? [],
		range,
		canManage,
		canViewAnalytics,
	})

	return (
		<main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-3 py-6 sm:px-4 sm:py-10 lg:gap-10">
			<ProgressiveAnalyticsDashboard initialRange={range} />
		</main>
	)
}
