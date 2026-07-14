// ─── Auth ────────────────────────────────────────────────────────────────────

function getApiKey(): string | null {
	return process.env.CONVERTKIT_V4_API_KEY ?? null
}

const KIT_BASE = 'https://api.kit.com/v4'
const KIT_MAX_PAGE_SIZE = 100
const KIT_MAX_PAGES = 10

async function kitFetch<T>(
	path: string,
	params?: Record<string, string>,
): Promise<T> {
	const key = getApiKey()
	if (!key) throw new Error('CONVERTKIT_V4_API_KEY is required')

	const url = new URL(`${KIT_BASE}${path}`)
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v)
		}
	}

	const res = await fetch(url.toString(), {
		headers: { 'X-Kit-Api-Key': key },
		next: { revalidate: 1800 }, // cache 30 min
	})

	if (!res.ok) {
		throw new Error(`Kit API error: ${res.status} ${res.statusText}`)
	}

	return res.json() as Promise<T>
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KitBroadcast {
	id: number
	subject: string
	createdAt: string
	sentAt: string | null
	status: string
}

export interface KitBroadcastStats {
	id: number
	recipients: number
	openRate: number
	emailsOpened: number
	clickRate: number
	totalClicks: number
	showTotalClicks: boolean
	unsubscribes: number
	unsubscribeRate: number
	progress: number
	openTrackingDisabled: boolean
	clickTrackingDisabled: boolean
	status: string
}

export interface KitLinkClick {
	url: string
	uniqueClicks: number
	clickToDeliveryRate: number
	clickToOpenRate: number
}

export interface KitBroadcastWithClicks {
	id: number
	subject: string
	sentAt: string | null
	stats: KitBroadcastStats
	clicks: KitLinkClick[]
}

// ─── API Functions ───────────────────────────────────────────────────────────

interface KitBroadcastRaw {
	id: number
	subject: string
	created_at: string
	sent_at?: string | null
	send_at?: string | null
	published_at?: string | null
	email_layout_template?: string
}

interface KitBroadcastStatsRaw {
	id: number
	stats: {
		recipients: number
		open_rate: number
		emails_opened?: number
		click_rate: number
		total_clicks: number
		show_total_clicks?: boolean
		unsubscribes: number
		unsubscribe_rate?: number
		progress?: number
		open_tracking_disabled?: boolean
		click_tracking_disabled?: boolean
		status: string
	}
}

interface KitClicksRaw {
	broadcast: {
		id: number
		clicks: {
			url: string
			unique_clicks: number
			click_to_delivery_rate: number
			click_to_open_rate: number
		}[]
	}
}

interface KitPaginationRaw {
	has_next_page?: boolean
	end_cursor?: string | null
}

interface KitBroadcastsPage<T> {
	broadcasts: T[]
	pagination?: KitPaginationRaw
}

async function fetchBroadcastPages<T>(
	path: '/broadcasts' | '/broadcasts/stats',
	targetCount: number,
	options: { filter?: (item: T) => boolean } = {},
): Promise<T[]> {
	const safeTarget = Math.max(0, Math.ceil(targetCount))
	if (safeTarget === 0) return []

	const results: T[] = []
	let after: string | undefined
	let pageCount = 0
	const pageSize = Math.min(Math.max(safeTarget * 2, 10), KIT_MAX_PAGE_SIZE)

	while (results.length < safeTarget && pageCount < KIT_MAX_PAGES) {
		const params: Record<string, string> = { per_page: String(pageSize) }
		if (after) params.after = after

		const data = await kitFetch<KitBroadcastsPage<T>>(path, params)
		for (const item of data.broadcasts ?? []) {
			if (!options.filter || options.filter(item)) {
				results.push(item)
			}
			if (results.length >= safeTarget) break
		}

		pageCount += 1
		if (!data.pagination?.has_next_page || !data.pagination.end_cursor) break
		after = data.pagination.end_cursor
	}

	return results
}

/**
 * List recent broadcasts for metadata lookup. Kit can return drafts/scheduled
 * broadcasts here; completed delivery state comes from `/broadcasts/stats`.
 */
export async function listBroadcasts(limit = 50): Promise<KitBroadcast[]> {
	const broadcasts = await fetchBroadcastPages<KitBroadcastRaw>(
		'/broadcasts',
		limit,
	)

	return broadcasts.map((b) => ({
		id: b.id,
		subject: b.subject ?? '',
		createdAt: b.created_at,
		sentAt: b.published_at ?? b.sent_at ?? b.send_at ?? null,
		status: b.published_at ? 'completed' : 'listed',
	}))
}

/**
 * Get bulk stats for all broadcasts.
 */
export async function getBroadcastStats(
	limit = 50,
): Promise<KitBroadcastStats[]> {
	const broadcasts = await fetchBroadcastPages<KitBroadcastStatsRaw>(
		'/broadcasts/stats',
		limit,
		{ filter: (b) => b.stats.status === 'completed' },
	)

	return broadcasts.map((b) => ({
		id: b.id,
		recipients: b.stats.recipients,
		openRate: b.stats.open_rate,
		emailsOpened: b.stats.emails_opened ?? 0,
		clickRate: b.stats.click_rate,
		totalClicks: b.stats.total_clicks,
		showTotalClicks: b.stats.show_total_clicks ?? true,
		unsubscribes: b.stats.unsubscribes,
		unsubscribeRate: b.stats.unsubscribe_rate ?? 0,
		progress: b.stats.progress ?? 0,
		openTrackingDisabled: b.stats.open_tracking_disabled ?? false,
		clickTrackingDisabled: b.stats.click_tracking_disabled ?? false,
		status: b.stats.status,
	}))
}

/**
 * Get per-link click data for a broadcast.
 */
export async function getBroadcastClicks(
	broadcastId: number,
): Promise<KitLinkClick[]> {
	const data = await kitFetch<KitClicksRaw>(`/broadcasts/${broadcastId}/clicks`)

	return (data.broadcast?.clicks ?? []).map((c) => ({
		url: c.url,
		uniqueClicks: c.unique_clicks,
		clickToDeliveryRate: c.click_to_delivery_rate,
		clickToOpenRate: c.click_to_open_rate,
	}))
}

/**
 * Get full broadcast details + stats + per-link clicks for recent broadcasts.
 * Merges list, stats, and clicks into a unified view.
 */
export async function getBroadcastsWithClicks(
	limit = 20,
): Promise<KitBroadcastWithClicks[]> {
	const safeLimit = Math.max(0, Math.ceil(limit))
	if (safeLimit === 0) return []

	const metadataLimit = Math.min(
		Math.max(safeLimit * 5, 50),
		KIT_MAX_PAGE_SIZE * KIT_MAX_PAGES,
	)
	const [broadcasts, allStats] = await Promise.all([
		listBroadcasts(metadataLimit),
		getBroadcastStats(safeLimit),
	])

	const broadcastMap = new Map(broadcasts.map((b) => [b.id, b]))

	// Use completed stats as the source of truth. Kit's broadcast list can include
	// drafts/scheduled emails ahead of completed broadcasts, so intersecting two
	// equally limited lists can make small limits return zero useful rows.
	const completed = allStats.slice(0, safeLimit)

	const results = new Map<number, KitBroadcastWithClicks>()
	for (const stats of completed) {
		const broadcast = broadcastMap.get(stats.id)
		results.set(stats.id, {
			id: stats.id,
			subject: broadcast?.subject ?? `Broadcast ${stats.id}`,
			sentAt: broadcast?.sentAt ?? null,
			stats,
			clicks: [],
		})
	}

	const completedWithClicks = completed.filter((stats) => stats.totalClicks > 0)

	// Fetch clicks in parallel (batched to avoid rate limits)
	const BATCH_SIZE = 5
	for (let i = 0; i < completedWithClicks.length; i += BATCH_SIZE) {
		const batch = completedWithClicks.slice(i, i + BATCH_SIZE)
		const clickResults = await Promise.all(
			batch.map((stats) => getBroadcastClicks(stats.id).catch(() => [])),
		)

		for (let j = 0; j < batch.length; j++) {
			const stats = batch[j]!
			const result = results.get(stats.id)
			if (result) result.clicks = clickResults[j]!
		}
	}

	return completed
		.map((stats) => results.get(stats.id))
		.filter(Boolean) as KitBroadcastWithClicks[]
}

/**
 * Check if Kit API is configured.
 */
export function isKitConfigured(): boolean {
	return !!getApiKey()
}

// ─── Subscriber count ────────────────────────────────────────────────────────

interface KitSubscribersCountRaw {
	// Kit v4 returns the total alongside pagination when
	// `include_total_count=true` is set; be liberal about where it lands.
	total_count?: number
	pagination?: KitPaginationRaw & { total_count?: number }
}

/**
 * Total count of active subscribers on the Kit (ConvertKit) account.
 *
 * Uses `GET /v4/subscribers?status=active&per_page=1&include_total_count=true`
 * and reads the `total_count` the v4 API includes when that flag is set
 * (there is no dedicated account-total endpoint in v4; growth/email stats
 * endpoints only report deltas over a date range).
 *
 * Cached 30 min via `kitFetch`'s `next.revalidate`. Returns `null` when the
 * Kit API key is not configured, on any API error, or when the returned
 * number is implausibly small (< 1000 — a mis-filtered response should fall
 * back to static copy rather than render a tiny number). Never throws.
 */
export async function getTotalSubscribers(): Promise<number | null> {
	if (!isKitConfigured()) return null

	try {
		const data = await kitFetch<KitSubscribersCountRaw>('/subscribers', {
			status: 'active',
			per_page: '1',
			include_total_count: 'true',
		})

		const total = data.total_count ?? data.pagination?.total_count
		if (
			typeof total !== 'number' ||
			!Number.isFinite(total) ||
			total < 1000
		) {
			return null
		}

		return Math.floor(total)
	} catch {
		return null
	}
}
