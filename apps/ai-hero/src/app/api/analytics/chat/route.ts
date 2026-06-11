import { NextRequest } from 'next/server'
import { getCatalog, query, type SurfaceName } from '@/lib/analytics'
import { traceAttribution } from '@/lib/analytics-queries'
import { getUserAbilityForRequest } from '@/server/ability-for-request'
import { log } from '@/server/logger'
import { withSkill } from '@/server/with-skill'
import { gateway } from '@ai-sdk/gateway'
import { stepCountIs, streamText, tool } from 'ai'
import { z } from 'zod'

const surfaceNames = getCatalog().map((s) => s.name) as [string, ...string[]]

const SYSTEM_PROMPT = `You are the AI Hero analytics agent. You answer questions about revenue, attribution, YouTube performance, traffic, and content effectiveness for a developer education platform.

You have direct access to the analytics surface catalog and can query it in real-time. When asked a question:
1. Identify which surfaces contain the answer
2. Query them (you can make multiple queries per turn)
3. Cross-reference the data
4. Give a specific, numbers-backed answer

Key context:
- YouTube is the #1 traffic source (~20K sessions/week from youtube.com)
- YouTube Analytics API lags by about 48 hours, so it is good for correlation and content analysis, not live operational reporting
- Attribution coverage is incomplete. "Dark" revenue has no source attribution
- Cohort 004 product ID is product-pqkk5. Use attribution/coverage, attribution/sources, surveys/responses, and traceAttribution for attribution coverage, support-channel, invoice, shortlink, and checkout survey attribution state
- Shortlinks are the only fully-traced attribution path (click → signup → purchase)
- First-touch attribution (UTMs, referrer, landing page) was recently deployed, historical data won't have it
- Revenue is in USD, stored in the Purchase table
- Video engagement data comes from both Mux (on-site) and YouTube (off-site)

When presenting numbers:
- Always state the time range
- Compare to previous period when possible
- Flag data quality caveats (e.g., attribution coverage %, YouTube's ~48h lag)
- Be direct. Matt wants answers, not caveats

When asked about a specific user's journey, use the traceAttribution tool with their email or purchaseId to see their full path: shortlink clicks → signup → content consumed → purchase.`

export const POST = withSkill(async (request: NextRequest) => {
	// Dual auth: device token OR session cookie
	let ability: any
	let user: any

	const canAccessAnalytics = (a: typeof ability) =>
		a?.can('manage', 'all') || a?.can('view', 'Analytics')

	const deviceAuth = await getUserAbilityForRequest(request)
	if (deviceAuth.ability && canAccessAnalytics(deviceAuth.ability)) {
		ability = deviceAuth.ability
		user = deviceAuth.user
	} else {
		const { getServerAuthSession } = await import('@/server/auth')
		const sessionAuth = await getServerAuthSession()
		ability = sessionAuth.ability
		user = sessionAuth.session?.user ?? null
	}

	if (!ability || !canAccessAnalytics(ability)) {
		void log.warn('api.analytics-chat.access-denied', {
			userId: (user as any)?.id ?? null,
			email: (user as any)?.email ?? null,
			authMethod: deviceAuth.user ? 'device_token' : 'session',
		})
		return new Response('Unauthorized', { status: 401 })
	}

	const { messages } = await request.json()

	await log.info('api.analytics-chat.query', {
		userId: (user as any)?.id ?? null,
		email: (user as any)?.email ?? null,
		authMethod: deviceAuth.user ? 'device_token' : 'session',
		messageCount: messages?.length,
	})

	const result = streamText({
		model: gateway('openai/gpt-5.4'),
		system: SYSTEM_PROMPT,
		messages,
		tools: {
			queryAnalytics: tool({
				description: `Query an analytics surface. Available: ${getCatalog()
					.map((s) => `${s.name} (${s.description})`)
					.join('; ')}`,
				inputSchema: z.object({
					surface: z.enum(surfaceNames),
					range: z.enum(['24h', '7d', '30d', '90d', 'all']).default('30d'),
					limit: z.number().optional(),
					productId: z.string().optional(),
					purchaseId: z.string().optional(),
					surveyId: z.string().optional(),
					surveySlug: z.string().optional(),
					questionId: z.string().optional(),
				}),
				execute: async ({
					surface,
					range,
					limit,
					productId,
					purchaseId,
					surveyId,
					surveySlug,
					questionId,
				}) => {
					const result = await query(surface as SurfaceName, {
						range: range as any,
						limit,
						productId,
						purchaseId,
						surveyId,
						surveySlug,
						questionId,
					})
					return result.ok ? result.data : result
				},
			}),
			compareRanges: tool({
				description:
					'Compare a surface across two time ranges (e.g., this week vs last month)',
				inputSchema: z.object({
					surface: z.enum(surfaceNames),
					currentRange: z.enum(['24h', '7d', '30d', '90d']),
					previousRange: z.enum(['24h', '7d', '30d', '90d']),
				}),
				execute: async ({ surface, currentRange, previousRange }) => {
					const [current, previous] = await Promise.all([
						query(surface as SurfaceName, { range: currentRange as any }),
						query(surface as SurfaceName, { range: previousRange as any }),
					])
					return {
						current: current.ok ? current.data : null,
						previous: previous.ok ? previous.data : null,
						currentRange,
						previousRange,
					}
				},
			}),
			computeMetric: tool({
				description:
					'Compute a derived metric like revenue-per-session or attribution coverage',
				inputSchema: z.object({
					metric: z.enum([
						'revenue_per_session',
						'youtube_to_purchase_rate',
						'attribution_coverage',
						'content_conversion_rate',
					]),
					range: z.enum(['7d', '30d', '90d']).default('30d'),
				}),
				execute: async ({ metric, range }) => {
					switch (metric) {
						case 'revenue_per_session': {
							const [rev, traf] = await Promise.all([
								query('summary', { range: range as any }),
								query('traffic', { range: range as any }),
							])
							const revenue = rev.ok ? ((rev.data as any).totalRevenue ?? 0) : 0
							const sessions = traf.ok ? ((traf.data as any).sessions ?? 1) : 1
							return {
								revenuePerSession: revenue / sessions,
								revenue,
								sessions,
							}
						}
						case 'attribution_coverage': {
							const cov = await query('attribution/coverage', {
								range: range as any,
							})
							return cov.ok ? cov.data : null
						}
						case 'content_conversion_rate': {
							const fun = await query('attribution/funnel', {
								range: range as any,
							})
							return fun.ok ? fun.data : null
						}
						case 'youtube_to_purchase_rate': {
							const [yt, rev] = await Promise.all([
								query('youtube', { range: range as any }),
								query('summary', { range: range as any }),
							])
							const views = yt.ok ? ((yt.data as any).viewCount ?? 1) : 1
							const purchases = rev.ok
								? ((rev.data as any).purchaseCount ?? 0)
								: 0
							return { rate: purchases / views, views, purchases }
						}
					}
				},
			}),
			traceAttribution: tool({
				description:
					'Trace the full attribution journey for a user. Walks: shortlink clicks → signup attribution → content progress → purchase. Provide email OR purchaseId.',
				inputSchema: z.object({
					email: z.string().email().optional(),
					purchaseId: z.string().optional(),
				}),
				execute: async ({ email, purchaseId }) => {
					if (!email && !purchaseId) {
						return { error: 'Provide either email or purchaseId' }
					}
					return traceAttribution({ email, purchaseId })
				},
			}),
		},
		stopWhen: stepCountIs(8),
	})

	return result.toUIMessageStreamResponse()
})
