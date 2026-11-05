import { z } from 'zod'
import { parseDrovrSignupDeliveryConfig } from './subscriber-marketing/drovr-doi-signup'

import type { AnalyticsRange } from './analytics/types'

type Env = Record<string, string | undefined>
const TENANT = 'org-aihero'
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Range = z.enum(['24h', '7d', '30d', '90d', 'all'])
const Mode = z.enum(['standard', 'strict'])
const Phase = z.enum([
	'capturing',
	'capture-paused',
	'captured',
	'freezing',
	'scheduled',
	'sending',
	'paused',
	'done',
	'cancelled',
])
// A shard reports drovr's BroadcastState, not the parent's lifecycle phase.
const ShardPhase = z.enum([
	'draft',
	'scheduled',
	'sending',
	'paused',
	'completed',
	'cancelled',
	'missing',
	'unreadable',
	'foreign',
])

/** Strict opt-in; no relation to the broadcast sending switch. */
export function reportingOffKitEnabled(env: Env = process.env): boolean {
	return env.AIH_REPORTING_OFF_KIT_ENABLED === 'true'
}

const BroadcastRef = z.object({
	broadcastId: z.string().min(1),
	kind: z.enum(['single', 'sharded']),
	/** Operator-supplied send instant, not a content publication date. */
	sentAt: z.string().datetime({ offset: true }),
})
const BroadcastRefs = z
	.array(BroadcastRef)
	.max(50)
	.refine(
		(refs) => new Set(refs.map((ref) => ref.broadcastId)).size === refs.length,
	)
const Stats = z.object({
	sent: Count,
	skipped: z.record(z.string(), Count),
	unknown: Count,
	versions: z.record(z.string(), Count),
	uncertain: Count.optional(),
})
const Status = z.object({
	captureComplete: z.boolean(),
	captured: Count,
	remaining: Count,
	// OpenAPI distinguishes the uncertainty flag from stats.uncertain count.
	uncertain: z.boolean(),
	stats: Stats,
	phase: Phase.optional(),
})
const SingleStatus = Status.extend({
	snapshot: z.object({
		context: z.object({ broadcastId: z.string(), tenantId: z.literal(TENANT) }),
	}),
}).transform(({ snapshot, ...status }) => ({ ...status, ...snapshot.context }))
const ShardedStatus = Status.extend({
	broadcastId: z.string(),
	tenantId: z.literal(TENANT),
	phase: z.union([Phase, z.literal('incomplete')]).optional(),
	count: z.number().int().min(1).max(32),
	shards: z.array(
		z.object({
			index: Count,
			phase: ShardPhase,
		}),
	),
})

// Mirrors drovr's broadcast_engagement contract at the boundary. Every
// section is known with its asOf and source, or unknown with a reason; an
// unknown section is never a zero.
const Sourced = { asOf: z.string().nullable(), source: z.string() }
const UnknownSection = z.object({
	...Sourced,
	status: z.literal('unknown'),
	reason: z.string(),
})
const known = <Shape extends z.ZodRawShape>(shape: Shape) =>
	z.discriminatedUnion('status', [
		z.object({ ...Sourced, ...shape, status: z.literal('known') }),
		UnknownSection,
	])
const Rate = z.number().nonnegative().nullable()
const EngagementRow = z.discriminatedUnion('status', [
	z.object({
		status: z.literal('known'),
		broadcastId: z.string(),
		mail: known({ captured: Count, remaining: Count, sent: Count }),
		delivery: known({
			bounced: z.object({ hard: Count, soft: Count }),
			complaints: Count,
			delivered: Count,
		}),
		opens: known({
			any: Count,
			machineOnly: Count,
			people: Count,
			byClass: z.object({
				'apple-mpp': Count,
				'proxy-cache': Count,
				scanner: Count,
				unconfirmed: Count,
			}),
		}),
		clicks: known({
			clicks: Count,
			people: Count,
			links: z.array(
				z.object({
					label: z.string(),
					version: z.string(),
					people: Count,
					clicks: Count,
				}),
			),
		}),
		unsubscribes: known({ count: Count }),
		rates: z.object({
			basis: z.enum(['delivered', 'sent']),
			denominator: Count.nullable(),
			openRate: Rate,
			anyOpenRate: Rate,
			clickRate: Rate,
			clickToOpenRate: Rate,
		}),
	}),
	UnknownSection.extend({ broadcastId: z.string() }),
])
// Rows parse one by one, so one malformed row can't hide the others.
const EngagementOutput = z.object({
	asOf: z.string(),
	tenantId: z.literal(TENANT),
	broadcasts: z.array(z.unknown()),
})

/** Renames drovr's sections so a person open can't pass for any open. */
function projectEngagement(
	row: Extract<z.infer<typeof EngagementRow>, { status: 'known' }>,
	asOf: string,
) {
	const { opens, clicks, rates } = row
	return {
		status: 'available' as const,
		asOf,
		rates: {
			basis: rates.basis,
			denominator: rates.denominator,
			openRate: rates.openRate,
			anyOpenRateIncludingMachineOpens: rates.anyOpenRate,
			clickRate: rates.clickRate,
			clickToOpenRate: rates.clickToOpenRate,
		},
		opens:
			opens.status === 'known'
				? {
						status: 'known' as const,
						asOf: opens.asOf,
						source: opens.source,
						emailsOpened: opens.people,
						anyOpenedIncludingMachineOpens: opens.any,
						machineOnly: opens.machineOnly,
						byClass: opens.byClass,
					}
				: opens,
		clicks:
			clicks.status === 'known'
				? {
						status: 'known' as const,
						asOf: clicks.asOf,
						source: clicks.source,
						totalClicks: clicks.clicks,
						uniqueClickers: clicks.people,
						links: clicks.links,
					}
				: clicks,
		mail: row.mail,
		delivery: row.delivery,
		unsubscribes: row.unsubscribes,
	}
}

const ENGAGEMENT_LABEL =
	'rows[].engagement comes from drovr broadcast_engagement, read separately from status. rates.openRate is person opens (opens.emailsOpened) over rates.denominator; rates.anyOpenRateIncludingMachineOpens also counts Apple Mail Privacy Protection prefetch and scanner loads, so it reads higher, close to Kit-style open rates. rates.basis is delivered when delivery is known, otherwise actor-reported sent, which counts bounces as mailed. clickRate and clickToOpenRate use distinct person clickers (clicks.uniqueClickers); clicks.totalClicks counts repeats. clicks.links[] gives people and clicks per link target (host and path) per message version. Opens and clicks are counted per message version, so a version two broadcasts sent counts in both. A section with status unknown carries its reason and is never zero; a null rate means an input is unknown.'

const unavailable = (reason: string) => ({
	status: 'unavailable' as const,
	reason,
})

type Read<T> = { status: 'available'; data: T } | ReturnType<typeof unavailable>

// Preserve complete exported Kit-era report data, but never load it from Kit.
// A snapshot must name its original query scope: rolling ranges must not be
// silently reinterpreted as today's period or another product's revenue.
const Link = z.object({
	url: z.string(),
	uniqueClicks: Count,
	clickToDeliveryRate: z.number(),
	clickToOpenRate: z.number(),
	shortlinkSlug: z.string().nullable().optional(),
})
const Campaign = z.object({
	broadcastId: Count,
	subject: z.string(),
	sentAt: z.string().nullable(),
	recipients: Count,
	openRate: z.number(),
	emailsOpened: Count.optional(),
	clickRate: z.number(),
	totalClicks: Count,
	showTotalClicks: z.boolean().optional(),
	unsubscribes: Count,
	unsubscribeRate: z.number().optional(),
	progress: z.number().optional(),
	openTrackingDisabled: z.boolean().optional(),
	clickTrackingDisabled: z.boolean().optional(),
	kitLinks: z.array(Link).optional(),
	shortlinks: z.array(
		z.object({
			slug: z.string(),
			url: z.string(),
			kitClicks: Count,
			clickToDeliveryRate: z.number().optional(),
			clickToOpenRate: z.number().optional(),
			shortlinkClicks: Count,
			signups: Count,
			purchases: Count,
			revenue: z.number(),
		}),
	),
	totalSignups: Count,
	totalPurchases: Count,
	totalRevenue: z.number(),
	clickToPurchaseRate: z.number(),
})
const HistoricalReport = z.object({
	asOf: z.string().datetime({ offset: true }),
	range: Range,
	mode: Mode,
	productId: z.string().optional(),
	data: z.object({
		configured: z.literal(true),
		totalBroadcasts: Count,
		totalRecipients: Count,
		totalRevenue: z.number(),
		campaigns: z.array(Campaign),
	}),
})
/** The shape AIH_REPORTING_KIT_HISTORY_JSON must parse as. */
export const HistoricalReports = z.array(HistoricalReport).max(50)
export type HistoricalReport = z.infer<typeof HistoricalReport>

function readHistory(
	env: Env,
	mode: z.infer<typeof Mode>,
	range: AnalyticsRange,
	productId?: string,
) {
	try {
		if (!env.AIH_REPORTING_KIT_HISTORY_JSON)
			return unavailable('No local Kit historical snapshot configured')
		const snapshots = HistoricalReports.parse(
			JSON.parse(env.AIH_REPORTING_KIT_HISTORY_JSON),
		)
		const matches = snapshots.filter(
			(snapshot) =>
				snapshot.mode === mode &&
				snapshot.range === range &&
				snapshot.productId === productId,
		)
		if (matches.length !== 1)
			return unavailable(
				'No unique local Kit historical snapshot for this query scope',
			)
		return { status: 'available' as const, data: matches[0]! }
	} catch {
		return unavailable('Local Kit historical snapshot is invalid')
	}
}

function sinceFor(range: AnalyticsRange, now: number): number | null {
	if (range === 'all') return null
	const hours = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }
	return now - hours[range] * 60 * 60 * 1000
}

/** Read-only HTTP projection. No provider fallback, and no exception text or
 * contact identities flow into the aggregate analytics response. */
export async function getOwnedNewsletterReport(args: {
	range: AnalyticsRange
	limit?: number
	mode: z.infer<typeof Mode>
	productId?: string
	env?: Env
	fetcher?: typeof fetch
	now?: number
}) {
	const env = args.env ?? process.env
	const now = args.now ?? Date.now()
	const since = sinceFor(args.range, now)
	const fetcher = args.fetcher ?? fetch
	const config = parseDrovrSignupDeliveryConfig(env)

	async function read<Schema extends z.ZodTypeAny>(
		path: string,
		schema: Schema,
		input?: unknown,
	): Promise<Read<z.infer<Schema>>> {
		if (!config) {
			return unavailable('drovr reporting credentials are not configured')
		}
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), 5_000)
		try {
			const response = await fetcher(`${config.baseUrl}${path}`, {
				method: input === undefined ? 'GET' : 'POST',
				headers: {
					accept: 'application/json',
					authorization: `Bearer ${config.apiKey}`,
					...(input === undefined
						? {}
						: { 'content-type': 'application/json' }),
				},
				...(input === undefined ? {} : { body: JSON.stringify(input) }),
				cache: 'no-store',
				signal: controller.signal,
			})
			if (!response.ok)
				return unavailable(`drovr reporting read failed (${response.status})`)
			const parsed = schema.safeParse(await response.json())
			return parsed.success
				? { status: 'available', data: parsed.data }
				: unavailable('drovr reporting response is invalid')
		} catch {
			return unavailable('drovr reporting read failed')
		} finally {
			clearTimeout(timer)
		}
	}

	async function broadcasts() {
		let refs: z.infer<typeof BroadcastRefs>
		try {
			if (!env.AIH_REPORTING_DROVR_BROADCASTS_JSON)
				return unavailable(
					'No exact drovr broadcast references configured; the catalog has no broadcast-list read',
				)
			refs = BroadcastRefs.parse(
				JSON.parse(env.AIH_REPORTING_DROVR_BROADCASTS_JSON),
			)
		} catch {
			return unavailable(
				'Exact drovr broadcast reference configuration is invalid',
			)
		}
		const filtered = refs
			.filter((ref) => {
				const sent = Date.parse(ref.sentAt)
				return sent <= now && (since === null || sent >= since)
			})
			.sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt))
		const limit = Number.isFinite(args.limit)
			? Math.max(0, Math.min(50, Math.floor(args.limit!)))
			: 20
		const selected = filtered.slice(0, limit)
		const [engagementById, rows] = await Promise.all([
			engagement(selected.map((ref) => ref.broadcastId)),
			statuses(selected),
		])
		return {
			status: 'available' as const,
			scope: 'Explicitly configured broadcasts only, not all tenant sends',
			matchedReferences: filtered.length,
			truncated: filtered.length > rows.length,
			engagementLabel: ENGAGEMENT_LABEL,
			rows: rows.map((row) => ({
				...row,
				engagement: engagementById(row.broadcastId),
			})),
		}
	}

	/** One batched read; a failure marks engagement unavailable, never status. */
	async function engagement(broadcastIds: string[]) {
		if (broadcastIds.length === 0) return () => unavailable('Not requested')
		const result = await read('/broadcast_engagement', EngagementOutput, {
			tenantId: TENANT,
			broadcastIds,
		})
		if (result.status === 'unavailable') return () => result
		const byId = new Map<
			string,
			ReturnType<typeof projectEngagement> | ReturnType<typeof unavailable>
		>()
		for (const raw of result.data.broadcasts) {
			const parsed = EngagementRow.safeParse(raw)
			if (!parsed.success) continue
			const row = parsed.data
			byId.set(
				row.broadcastId,
				row.status === 'known'
					? projectEngagement(row, result.data.asOf)
					: unavailable(row.reason),
			)
		}
		return (broadcastId: string) =>
			byId.get(broadcastId) ??
			unavailable('drovr engagement row is missing or invalid')
	}

	function statuses(selected: z.infer<typeof BroadcastRefs>) {
		return Promise.all(
			selected.map(async (ref) => {
				const address = { tenantId: TENANT, broadcastId: ref.broadcastId }
				if (ref.kind === 'sharded') {
					const result = await read(
						'/sharded_broadcast_status',
						z.object({ sharded: ShardedStatus }),
						address,
					)
					if (result.status === 'unavailable') return { ...ref, result }
					const data = result.data.sharded
					if (
						data.broadcastId !== ref.broadcastId ||
						data.phase === 'incomplete' ||
						data.shards.length !== data.count ||
						new Set(data.shards.map((shard) => shard.index)).size !==
							data.count ||
						data.shards.some(
							(shard) =>
								shard.index >= data.count ||
								['missing', 'unreadable', 'foreign'].includes(shard.phase),
						)
					) {
						return {
							...ref,
							result: unavailable(
								'drovr broadcast has incomplete or mismatched shards; partial totals are not complete results',
							),
						}
					}
					return { ...ref, result: { status: 'available' as const, data } }
				}
				const result = await read(
					'/broadcast_status',
					z.object({ broadcast: SingleStatus }),
					address,
				)
				if (
					result.status === 'available' &&
					result.data.broadcast.broadcastId !== ref.broadcastId
				) {
					return {
						...ref,
						result: unavailable(
							'drovr broadcast identity does not match the exact reference',
						),
					}
				}
				return {
					...ref,
					result:
						result.status === 'available'
							? { status: 'available' as const, data: result.data.broadcast }
							: result,
				}
			}),
		)
	}

	async function receiptSample() {
		const result = await read(
			'/receipts?limit=200',
			z.object({
				receipts: z
					.array(
						z.object({
							tenantId: z.literal(TENANT),
							at: z.string().datetime({ offset: true }),
							journeyId: z.string(),
						}),
					)
					.max(200),
			}),
		)
		if (result.status === 'unavailable') return result
		const receipts = result.data.receipts
		const times = receipts
			.map((receipt) => receipt.at)
			.sort((a, b) => Date.parse(a) - Date.parse(b))
		return {
			status: 'available' as const,
			sampleSize: receipts.length,
			oldestAt: times[0] ?? null,
			newestAt: times.at(-1) ?? null,
		}
	}

	const [current, transitions] = await Promise.all([
		broadcasts(),
		receiptSample(),
	])
	return {
		provider: 'drovr' as const,
		asOf: new Date(now).toISOString(),
		period: {
			kind: 'current' as const,
			range: args.range,
			since: since === null ? null : new Date(since).toISOString(),
			until: new Date(now).toISOString(),
		},
		mode: args.mode,
		broadcasts: current,
		metricScope:
			'Status counters and engagement counts are lifetime counts for each referenced send, not events in the requested period. Sent is actor-reported sent, not delivery, open or click evidence.',
		productAttribution: unavailable(
			'drovr status does not expose product-level attribution; productId does not filter broadcast status',
		),
		attributedRevenue: unavailable(
			'drovr reads do not expose attributed revenue; opens and clicks are on broadcasts.rows[].engagement',
		),
		receiptSample: {
			label:
				'Latest committed journey transitions, at most 200 across the tenant, independent of the requested range. Not broadcast deliveries, not a complete log, not a sent-total reconciliation.',
			...transitions,
		},
		historical: {
			label:
				'Historical Kit-era snapshot, frozen at its asOf and original query scope. Not current drovr results.',
			...readHistory(env, args.mode, args.range, args.productId),
		},
	}
}

export type OwnedNewsletterReport = Awaited<
	ReturnType<typeof getOwnedNewsletterReport>
>
