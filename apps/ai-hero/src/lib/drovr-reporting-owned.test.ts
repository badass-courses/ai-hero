import { createAnalyticsEngine } from '@coursebuilder/analytics/engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const kit = vi.hoisted(() => ({ configured: vi.fn(), broadcasts: vi.fn() }))
vi.mock('@/lib/kit-data', () => ({
	isKitConfigured: kit.configured,
	getBroadcastsWithClicks: kit.broadcasts,
}))
vi.mock('@/db/client', () => ({
	db: {
		select: () => {
			throw new Error('Unexpected database read')
		},
	},
}))
vi.mock('@/db/schema', () => ({
	purchases: {},
	shortlink: {},
	shortlinkAttribution: {},
	shortlinkClick: {},
}))

import * as newsletter from './analytics/providers/newsletter'
import {
	getOwnedNewsletterReport,
	reportingOffKitEnabled,
} from './reporting-owned'

const now = Date.parse('2026-11-01T06:00:00Z')
const ref = {
	broadcastId: 'synthetic-send',
	kind: 'single',
	sentAt: '2026-11-01T05:00:00Z',
}
const stats = {
	sent: 7,
	skipped: { suppressed: 1 },
	unknown: 2,
	versions: { v1: 7 },
}
const status = {
	phase: 'sending',
	captureComplete: true,
	captured: 12,
	remaining: 2,
	uncertain: false,
	stats,
}
const singleStatus = {
	...status,
	snapshot: {
		context: { broadcastId: ref.broadcastId, tenantId: 'org-aihero' },
	},
}
const sourced = { asOf: '2026-11-01T05:59:00Z', source: 'synthetic-source' }
const knownEngagement = {
	status: 'known',
	broadcastId: ref.broadcastId,
	kind: 'single',
	messageId: 'synthetic-message',
	versions: ['v1'],
	shards: 1,
	startAt: ref.sentAt,
	mail: { ...sourced, status: 'known', captured: 12, sent: 7, remaining: 2 },
	delivery: {
		...sourced,
		status: 'known',
		delivered: 6,
		bounced: { hard: 1, soft: 0 },
		complaints: 0,
	},
	opens: {
		...sourced,
		status: 'known',
		any: 5,
		people: 3,
		machineOnly: 2,
		byClass: { 'apple-mpp': 2, 'proxy-cache': 1, scanner: 0, unconfirmed: 2 },
	},
	clicks: {
		...sourced,
		status: 'known',
		clicks: 4,
		people: 2,
		links: [
			{ label: 'example.test/a', version: 'v1', people: 2, clicks: 3 },
			{ label: 'example.test/b', version: 'v1', people: 1, clicks: 1 },
		],
	},
	unsubscribes: { ...sourced, status: 'known', count: 1 },
	rates: {
		basis: 'delivered',
		denominator: 6,
		openRate: 0.5,
		anyOpenRate: 5 / 6,
		clickRate: 2 / 6,
		clickToOpenRate: 2 / 3,
	},
}
const engagementBody = {
	asOf: '2026-11-01T06:00:00Z',
	tenantId: 'org-aihero',
	broadcasts: [knownEngagement],
	nextMoves: [],
}
const response = (body: unknown, code = 200) =>
	new Response(JSON.stringify(body), { status: code })
const env = {
	AIH_REPORTING_OFF_KIT_ENABLED: 'true',
	DROVR_API_BASE_URL: 'https://drovr.example.test',
	DROVR_API_KEY_ORG_AIHERO: 'synthetic-key',
	AIH_REPORTING_DROVR_BROADCASTS_JSON: JSON.stringify([ref]),
}
const historic = {
	asOf: '2026-10-31T00:00:00Z',
	range: 'all',
	mode: 'standard',
	data: {
		configured: true,
		totalBroadcasts: 1,
		totalRecipients: 100,
		totalRevenue: 199,
		campaigns: [
			{
				broadcastId: 123,
				subject: 'Synthetic historical campaign',
				sentAt: '2026-10-30T00:00:00Z',
				recipients: 100,
				openRate: 0.5,
				clickRate: 0.1,
				totalClicks: 10,
				unsubscribes: 1,
				shortlinks: [
					{
						slug: 'synthetic',
						url: 'https://example.test/s/synthetic',
						kitClicks: 10,
						shortlinkClicks: 8,
						signups: 2,
						purchases: 1,
						revenue: 199,
					},
				],
				totalSignups: 2,
				totalPurchases: 1,
				totalRevenue: 199,
				clickToPurchaseRate: 0.1,
			},
		],
	},
}

function fakeDrovr() {
	return vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
		async (url, init) => {
			expect(String(url)).toMatch(/^https:\/\/drovr\.example\.test\//)
			expect(init?.headers).toMatchObject({
				authorization: 'Bearer synthetic-key',
			})
			expect(init?.cache).toBe('no-store')
			if (String(url).endsWith('/broadcast_status')) {
				expect(init?.method).toBe('POST')
				expect(JSON.parse(String(init?.body))).toEqual({
					tenantId: 'org-aihero',
					broadcastId: ref.broadcastId,
				})
				return response({ broadcast: singleStatus })
			}
			if (String(url).endsWith('/broadcast_engagement')) {
				expect(init?.method).toBe('POST')
				expect(JSON.parse(String(init?.body))).toEqual({
					tenantId: 'org-aihero',
					broadcastIds: [ref.broadcastId],
				})
				return response(engagementBody)
			}
			if (String(url).endsWith('/receipts?limit=200')) {
				expect(init?.method).toBe('GET')
				return response({
					receipts: [
						{
							tenantId: 'org-aihero',
							contactId: 'private-contact',
							at: ref.sentAt,
							journeyId: 'shadow-newsletter',
						},
					],
				})
			}
			throw new Error(`Unexpected fake route: ${url}`)
		},
	)
}

beforeEach(() => {
	vi.resetAllMocks()
	vi.useFakeTimers()
	vi.setSystemTime(now)
	kit.configured.mockImplementation(() => {
		throw new Error('Kit is unreachable')
	})
	kit.broadcasts.mockRejectedValue(new Error('Kit is unreachable'))
})
afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe('newsletter report readers with Kit unreachable', () => {
	it.each([
		'getEmailCampaignAttribution',
		'getEmailCampaignAttributionStrict',
	] as const)(
		'%s renders owned data through the analytics engine without any Kit calls',
		async (fn) => {
			for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
			vi.stubEnv(
				'AIH_REPORTING_KIT_HISTORY_JSON',
				JSON.stringify([
					{ ...historic, mode: fn.endsWith('Strict') ? 'strict' : 'standard' },
				]),
			)
			const fetcher = fakeDrovr()
			vi.stubGlobal('fetch', fetcher)
			const surface = fn.endsWith('Strict')
				? 'attribution/email-campaigns/strict'
				: 'attribution/email-campaigns'
			const engine = createAnalyticsEngine({ newsletter })
			const result = await engine.query(surface, { range: 'all' })
			expect(result).toMatchObject({
				ok: true,
				data: {
					provider: 'drovr',
					period: { kind: 'current', range: 'all' },
					broadcasts: {
						status: 'available',
						rows: [
							{
								broadcastId: ref.broadcastId,
								result: { status: 'available', data: status },
							},
						],
					},
					receiptSample: { status: 'available', sampleSize: 1 },
					historical: {
						status: 'available',
						data: { data: historic.data, asOf: historic.asOf },
					},
					attributedRevenue: { status: 'unavailable' },
				},
			})
			const rendered = JSON.stringify(result)
			expect(rendered).toContain('Not broadcast deliveries')
			expect(rendered).toContain('Historical Kit-era snapshot')
			expect(rendered).not.toContain('private-contact')
			expect(rendered).not.toContain('synthetic-key')
			expect(kit.configured).not.toHaveBeenCalled()
			expect(kit.broadcasts).not.toHaveBeenCalled()
			expect(fetcher).toHaveBeenCalledTimes(3)
		},
	)

	it.each(['false', '', 'TRUE', '1'])(
		'flag %j preserves the existing Kit path and result',
		async (flag) => {
			vi.stubEnv('AIH_REPORTING_OFF_KIT_ENABLED', flag)
			const fetcher = vi.fn()
			vi.stubGlobal('fetch', fetcher)
			kit.configured.mockReturnValue(true)
			kit.broadcasts.mockResolvedValue([])
			for (const fn of [
				newsletter.getEmailCampaignAttribution,
				newsletter.getEmailCampaignAttributionStrict,
			]) {
				expect(await fn('all')).toEqual({
					configured: true,
					totalBroadcasts: 0,
					totalRecipients: 0,
					totalRevenue: 0,
					campaigns: [],
				})
			}
			expect(kit.broadcasts).toHaveBeenCalledTimes(2)
			expect(fetcher).not.toHaveBeenCalled()
		},
	)
	it('flag off preserves a nonempty Kit funnel, including its metrics', async () => {
		vi.stubEnv('AIH_REPORTING_OFF_KIT_ENABLED', 'false')
		const fetcher = vi.fn()
		vi.stubGlobal('fetch', fetcher)
		kit.configured.mockReturnValue(true)
		kit.broadcasts.mockResolvedValue([
			{
				id: 123,
				subject: 'Synthetic Kit send',
				sentAt: ref.sentAt,
				stats: {
					recipients: 10,
					openRate: 0.5,
					clickRate: 0.1,
					totalClicks: 1,
					unsubscribes: 0,
				},
				clicks: [],
			},
		])
		for (const fn of [
			newsletter.getEmailCampaignAttribution,
			newsletter.getEmailCampaignAttributionStrict,
		]) {
			expect(await fn('all')).toMatchObject({
				configured: true,
				totalBroadcasts: 1,
				totalRecipients: 10,
				totalRevenue: 0,
				campaigns: [
					{
						broadcastId: 123,
						subject: 'Synthetic Kit send',
						recipients: 10,
						openRate: 0.5,
						clickRate: 0.1,
						totalClicks: 1,
						unsubscribes: 0,
						kitLinks: [],
						shortlinks: [],
					},
				],
			})
		}
		expect(fetcher).not.toHaveBeenCalled()
	})
	it('defaults off', () => expect(reportingOffKitEnabled({})).toBe(false))
})

describe('drovr report evidence and unavailable states', () => {
	it.each([401, 429, 503])(
		'HTTP %i is unavailable, never zero',
		async (code) => {
			const report = await getOwnedNewsletterReport({
				env,
				range: 'all',
				mode: 'standard',
				now,
				fetcher: vi.fn(async () => response({}, code)),
			})
			expect(report.broadcasts).toMatchObject({
				rows: [{ result: { status: 'unavailable' } }],
			})
			expect(report.receiptSample.status).toBe('unavailable')
			expect(JSON.stringify(report)).not.toContain('"sent":0')
			expect(report).not.toHaveProperty('totalRevenue')
		},
	)
	it('network failure and malformed success are unavailable', async () => {
		for (const fetcher of [
			vi.fn(async () => {
				throw new Error('private-network-details')
			}),
			vi.fn(async () => response({})),
		]) {
			const report = await getOwnedNewsletterReport({
				env,
				range: 'all',
				mode: 'standard',
				now,
				fetcher,
			})
			expect(report.broadcasts).toMatchObject({
				rows: [{ result: { status: 'unavailable' } }],
			})
			expect(report.receiptSample.status).toBe('unavailable')
			expect(JSON.stringify(report)).not.toContain('private-network-details')
		}
	})
	it('a stalled read times out and clears its timers', async () => {
		const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => reject(new Error('aborted')),
						{ once: true },
					)
				}),
		)
		const pending = getOwnedNewsletterReport({
			env,
			range: 'all',
			mode: 'standard',
			now,
			fetcher,
		})
		await vi.advanceTimersByTimeAsync(5_000)
		expect((await pending).receiptSample.status).toBe('unavailable')
		expect(vi.getTimerCount()).toBe(0)
	})
	it('reads statuses and receipts with only the ingest URL configured', async () => {
		const fetcher = fakeDrovr()
		const report = await getOwnedNewsletterReport({
			env: {
				...env,
				DROVR_API_BASE_URL: undefined,
				DROVR_SHADOW_INGEST_URL: 'https://drovr.example.test/events',
			},
			range: 'all',
			mode: 'standard',
			now,
			fetcher,
		})
		expect(report.broadcasts).toMatchObject({
			rows: [{ result: { status: 'available' } }],
		})
		expect(report.receiptSample.status).toBe('available')
		expect(fetcher).toHaveBeenCalledTimes(3)
	})
	it('prefers an explicit base URL and trims configuration through the shared parser', async () => {
		const fetcher = fakeDrovr()
		const report = await getOwnedNewsletterReport({
			env: {
				...env,
				DROVR_API_BASE_URL: ' https://drovr.example.test/// ',
				DROVR_API_KEY_ORG_AIHERO: ' synthetic-key ',
				DROVR_SHADOW_INGEST_URL: 'https://unused.example.test/events',
			},
			range: 'all',
			mode: 'standard',
			now,
			fetcher,
		})
		expect(report.receiptSample.status).toBe('available')
		expect(fetcher).toHaveBeenCalledTimes(3)
	})
	it.each([undefined, 'not-a-url'])(
		'absent or invalid fallback %j stays unavailable without a network call',
		async (ingest) => {
			const fetcher = vi.fn()
			const report = await getOwnedNewsletterReport({
				env: {
					...env,
					DROVR_API_BASE_URL: undefined,
					DROVR_SHADOW_INGEST_URL: ingest,
				},
				range: 'all',
				mode: 'standard',
				now,
				fetcher,
			})
			expect(report.broadcasts).toMatchObject({
				rows: [{ result: { status: 'unavailable' } }],
			})
			expect(report.receiptSample.status).toBe('unavailable')
			expect(fetcher).not.toHaveBeenCalled()
		},
	)
	it('missing credentials make no network call', async () => {
		const fetcher = vi.fn()
		const report = await getOwnedNewsletterReport({
			env: { ...env, DROVR_API_KEY_ORG_AIHERO: undefined },
			range: 'all',
			mode: 'standard',
			now,
			fetcher,
		})
		expect(report.receiptSample.status).toBe('unavailable')
		expect(fetcher).not.toHaveBeenCalled()
	})
	it.each([undefined, 'not-json', '[{}]', JSON.stringify([ref, ref])])(
		'missing or invalid exact references %j are not an empty successful report',
		async (refs) => {
			const fetcher = fakeDrovr()
			const report = await getOwnedNewsletterReport({
				env: { ...env, AIH_REPORTING_DROVR_BROADCASTS_JSON: refs },
				range: 'all',
				mode: 'standard',
				now,
				fetcher,
			})
			expect(report.broadcasts.status).toBe('unavailable')
			expect(fetcher).toHaveBeenCalledTimes(1)
		},
	)
	it('filters references by send instant, caps rows and declares truncation', async () => {
		const refs = [
			ref,
			{ ...ref, broadcastId: 'older', sentAt: '2026-09-01T05:00:00Z' },
			{ ...ref, broadcastId: 'future', sentAt: '2027-01-01T00:00:00Z' },
		]
		const report = await getOwnedNewsletterReport({
			env: {
				...env,
				AIH_REPORTING_DROVR_BROADCASTS_JSON: JSON.stringify(refs),
			},
			range: '24h',
			mode: 'standard',
			now,
			limit: 0,
			fetcher: fakeDrovr(),
		})
		expect(report.broadcasts).toMatchObject({
			status: 'available',
			matchedReferences: 1,
			truncated: true,
			rows: [],
		})
	})
	it('does not invent sent from captured or turn missing counters into zero', async () => {
		const fetcher = vi.fn(async () =>
			response({
				broadcast: { ...singleStatus, stats: { ...stats, sent: undefined } },
			}),
		)
		const report = await getOwnedNewsletterReport({
			env,
			range: 'all',
			mode: 'standard',
			now,
			fetcher,
		})
		expect(report.broadcasts).toMatchObject({
			rows: [{ result: { status: 'unavailable' } }],
		})
	})
	it.each(['wrong-id', 'wrong-tenant'])(
		'rejects single-broadcast identity mismatch %s',
		async (mismatch) => {
			const context = {
				broadcastId: mismatch === 'wrong-id' ? 'wrong' : ref.broadcastId,
				tenantId: mismatch === 'wrong-tenant' ? 'other-tenant' : 'org-aihero',
			}
			const report = await getOwnedNewsletterReport({
				env,
				range: 'all',
				mode: 'standard',
				now,
				fetcher: vi.fn(async () =>
					response({ broadcast: { ...singleStatus, snapshot: { context } } }),
				),
			})
			expect(report.broadcasts).toMatchObject({
				rows: [{ result: { status: 'unavailable' } }],
			})
		},
	)
	it('real zero is preserved only when proven by a valid status', async () => {
		const fetcher = vi.fn(async () =>
			response({
				broadcast: { ...singleStatus, stats: { ...stats, sent: 0 } },
			}),
		)
		const report = await getOwnedNewsletterReport({
			env,
			range: 'all',
			mode: 'standard',
			now,
			fetcher,
		})
		expect(report.broadcasts).toMatchObject({
			rows: [{ result: { status: 'available', data: { stats: { sent: 0 } } } }],
		})
	})
	it('keeps a good broadcast readable when receipt storage fails', async () => {
		const fetcher = fakeDrovr()
		fetcher.mockImplementation(async (url) =>
			String(url).endsWith('/broadcast_status')
				? response({ broadcast: singleStatus })
				: response({}, 503),
		)
		const report = await getOwnedNewsletterReport({
			env,
			range: 'all',
			mode: 'standard',
			now,
			fetcher,
		})
		expect(report.broadcasts).toMatchObject({
			rows: [{ result: { status: 'available' } }],
		})
		expect(report.receiptSample.status).toBe('unavailable')
	})
	it('supports complete sharded status but refuses partial or mismatched totals', async () => {
		const sharded = {
			...status,
			tenantId: 'org-aihero',
			broadcastId: ref.broadcastId,
			count: 1,
			shards: [{ index: 0, phase: 'sending' }],
		}
		for (const [value, expected] of [
			[sharded, 'available'],
			[{ ...sharded, phase: 'incomplete' }, 'unavailable'],
			[{ ...sharded, shards: [] }, 'unavailable'],
			[{ ...sharded, broadcastId: 'wrong' }, 'unavailable'],
			[
				{ ...sharded, shards: [{ index: 0, phase: 'unreadable' }] },
				'unavailable',
			],
		] as const) {
			const fetcher = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>(
				async (url) =>
					String(url).endsWith('/sharded_broadcast_status')
						? response({ sharded: value })
						: response({ receipts: [] }),
			)
			const report = await getOwnedNewsletterReport({
				env: {
					...env,
					AIH_REPORTING_DROVR_BROADCASTS_JSON: JSON.stringify([
						{ ...ref, kind: 'sharded' },
					]),
				},
				range: 'all',
				mode: 'standard',
				now,
				fetcher,
			})
			expect(report.broadcasts).toMatchObject({
				rows: [{ result: { status: expected } }],
			})
		}
	})
	it('reads drovr shard states, and still refuses a missing shard', async () => {
		const shard = (index: number, phase: string) => ({
			index,
			phase,
			captured: 40,
			remaining: 0,
			captureComplete: true,
		})
		const done = {
			...status,
			phase: 'done',
			tenantId: 'org-aihero',
			broadcastId: ref.broadcastId,
			count: 2,
			shards: [shard(0, 'completed'), shard(1, 'completed')],
		}
		for (const [value, expected] of [
			[done, 'available'],
			[
				{
					...done,
					phase: 'scheduled',
					shards: [shard(0, 'draft'), shard(1, 'scheduled')],
				},
				'available',
			],
			[
				{ ...done, shards: [shard(0, 'completed'), shard(1, 'missing')] },
				'unavailable',
			],
		] as const) {
			const report = await getOwnedNewsletterReport({
				env: {
					...env,
					AIH_REPORTING_DROVR_BROADCASTS_JSON: JSON.stringify([
						{ ...ref, kind: 'sharded' },
					]),
				},
				range: 'all',
				mode: 'standard',
				now,
				fetcher: vi.fn(async (url: string | URL | Request) =>
					String(url).endsWith('/sharded_broadcast_status')
						? response({ sharded: value })
						: response({ receipts: [] }),
				),
			})
			const row =
				report.broadcasts.status === 'available'
					? report.broadcasts.rows[0]
					: null
			expect(row?.result.status).toBe(expected)
			if (expected === 'unavailable')
				expect(row?.result).toMatchObject({
					reason: expect.stringContaining('incomplete or mismatched shards'),
				})
		}
	})
	it('history stays available during a drovr outage and never crosses mode/product/range', async () => {
		const configured = {
			...env,
			AIH_REPORTING_KIT_HISTORY_JSON: JSON.stringify([
				historic,
				{ ...historic, mode: 'strict', productId: 'synthetic-product' },
			]),
		}
		const fetcher = vi.fn(async () => response({}, 503))
		const read = (
			mode: 'standard' | 'strict',
			range: 'all' | '7d',
			productId?: string,
		) =>
			getOwnedNewsletterReport({
				env: configured,
				mode,
				range,
				productId,
				fetcher,
				now,
			})
		expect((await read('standard', 'all')).historical).toMatchObject({
			status: 'available',
			data: historic,
		})
		expect((await read('standard', '7d')).historical.status).toBe('unavailable')
		expect((await read('strict', 'all')).historical.status).toBe('unavailable')
		expect(
			(await read('strict', 'all', 'synthetic-product')).historical.status,
		).toBe('available')
		expect(
			(await read('strict', 'all', 'other-product')).historical.status,
		).toBe('unavailable')
	})
	it.each(['not-json', '[{}]', JSON.stringify([historic, historic])])(
		'bad or ambiguous archive %j is unavailable',
		async (archive) => {
			const report = await getOwnedNewsletterReport({
				env: { ...env, AIH_REPORTING_KIT_HISTORY_JSON: archive },
				range: 'all',
				mode: 'standard',
				now,
				fetcher: fakeDrovr(),
			})
			expect(report.historical.status).toBe('unavailable')
		},
	)
})

describe('drovr broadcast engagement', () => {
	const readRow = async (fetcher: ReturnType<typeof fakeDrovr>) => {
		const report = await getOwnedNewsletterReport({
			env,
			range: 'all',
			mode: 'standard',
			now,
			fetcher,
		})
		if (report.broadcasts.status !== 'available')
			throw new Error('expected broadcasts')
		return report.broadcasts.rows[0]!
	}
	const withEngagement = (body: unknown, code = 200) => {
		const fetcher = fakeDrovr()
		const fake = fetcher.getMockImplementation()!
		fetcher.mockImplementation(async (url, init) =>
			String(url).endsWith('/broadcast_engagement')
				? response(body, code)
				: fake(url, init),
		)
		return fetcher
	}

	it('maps a known row onto the manifest row beside its status', async () => {
		const row = await readRow(fakeDrovr())
		expect(row.result).toMatchObject({ status: 'available', data: status })
		expect(row.engagement).toEqual({
			status: 'available',
			asOf: engagementBody.asOf,
			rates: {
				basis: 'delivered',
				denominator: 6,
				openRate: 0.5,
				anyOpenRateIncludingMachineOpens: 5 / 6,
				clickRate: 2 / 6,
				clickToOpenRate: 2 / 3,
			},
			opens: {
				...sourced,
				status: 'known',
				emailsOpened: 3,
				anyOpenedIncludingMachineOpens: 5,
				machineOnly: 2,
				byClass: knownEngagement.opens.byClass,
			},
			clicks: {
				...sourced,
				status: 'known',
				totalClicks: 4,
				uniqueClickers: 2,
				links: knownEngagement.clicks.links,
			},
			mail: knownEngagement.mail,
			delivery: knownEngagement.delivery,
			unsubscribes: knownEngagement.unsubscribes,
		})
	})

	it('keeps unknown sections unknown with their reason, never zero', async () => {
		const unknown = (reason: string) => ({
			asOf: null,
			source: 'synthetic-source',
			status: 'unknown',
			reason,
		})
		const row = await readRow(
			withEngagement({
				...engagementBody,
				broadcasts: [
					{
						...knownEngagement,
						opens: unknown('index pending'),
						delivery: unknown('delivery not read yet'),
						unsubscribes: unknown('not attributed yet'),
						rates: {
							basis: 'sent',
							denominator: 7,
							openRate: null,
							anyOpenRate: null,
							clickRate: 2 / 7,
							clickToOpenRate: null,
						},
					},
				],
			}),
		)
		expect(row.engagement).toMatchObject({
			status: 'available',
			rates: { basis: 'sent', openRate: null, clickToOpenRate: null },
			opens: { status: 'unknown', reason: 'index pending' },
			delivery: { status: 'unknown', reason: 'delivery not read yet' },
			unsubscribes: { status: 'unknown', reason: 'not attributed yet' },
			clicks: { status: 'known', totalClicks: 4 },
		})
		expect(row.engagement).not.toHaveProperty('opens.emailsOpened')
	})

	it('an unknown drovr row reads unavailable with its reason', async () => {
		const row = await readRow(
			withEngagement({
				...engagementBody,
				broadcasts: [
					{
						asOf: null,
						source: 'synthetic-source',
						status: 'unknown',
						reason: 'shard unreadable',
						broadcastId: ref.broadcastId,
					},
				],
			}),
		)
		expect(row.engagement).toEqual({
			status: 'unavailable',
			reason: 'shard unreadable',
		})
		expect(row.result.status).toBe('available')
	})

	it.each([
		['HTTP 503', () => withEngagement({}, 503)],
		['a malformed body', () => withEngagement({ broadcasts: 'nope' })],
		[
			'a foreign tenant',
			() => withEngagement({ ...engagementBody, tenantId: 'other-tenant' }),
		],
		[
			'a missing row',
			() => withEngagement({ ...engagementBody, broadcasts: [] }),
		],
		[
			'a malformed row',
			() =>
				withEngagement({
					...engagementBody,
					broadcasts: [{ ...knownEngagement, opens: { status: 'known' } }],
				}),
		],
	])('%s leaves the status row intact', async (_case, make) => {
		const row = await readRow(make())
		expect(row.result).toMatchObject({ status: 'available', data: status })
		expect(row.engagement.status).toBe('unavailable')
		expect(JSON.stringify(row.engagement)).not.toContain('"emailsOpened"')
	})

	it('a thrown engagement read leaves the status row intact', async () => {
		const fetcher = fakeDrovr()
		const fake = fetcher.getMockImplementation()!
		fetcher.mockImplementation(async (url, init) => {
			if (String(url).endsWith('/broadcast_engagement'))
				throw new Error('private-network-details')
			return fake(url, init)
		})
		const row = await readRow(fetcher)
		expect(row.result.status).toBe('available')
		expect(row.engagement).toEqual({
			status: 'unavailable',
			reason: 'drovr reporting read failed',
		})
	})
})
