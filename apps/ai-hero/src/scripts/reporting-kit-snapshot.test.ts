import { describe, expect, it, vi } from 'vitest'

import {
	getOwnedNewsletterReport,
	HistoricalReports,
} from '@/lib/reporting-owned'

import {
	byteSize,
	c5Range,
	captureSnapshots,
	describeSnapshots,
	fallbackScopes,
	fitBudget,
	fullScopes,
	memoizeKitReads,
	parseSnapshotArgs,
	selectScopes,
	trimLinks,
	type Scope,
} from './reporting-kit-snapshot'

const now = Date.parse('2026-11-01T12:00:00Z')
const asOf = new Date(now).toISOString()

function campaign(id: number, links = 2) {
	const urls = Array.from(
		{ length: links },
		(_, i) => `https://www.aihero.dev/s/synthetic-${id}-${i}`,
	)
	return {
		broadcastId: id,
		subject: `Synthetic subject ${id}`,
		sentAt: '2026-10-30T00:00:00.000Z',
		recipients: 1000,
		openRate: 0.5,
		emailsOpened: 500,
		clickRate: 0.1,
		totalClicks: 100,
		showTotalClicks: true,
		unsubscribes: 3,
		unsubscribeRate: 0.003,
		progress: 100,
		openTrackingDisabled: false,
		clickTrackingDisabled: false,
		kitLinks: urls.map((url, i) => ({
			url,
			uniqueClicks: 10,
			clickToDeliveryRate: 0.01,
			clickToOpenRate: 0.02,
			shortlinkSlug: `synthetic-${id}-${i}`,
		})),
		shortlinks: urls.map((url, i) => ({
			slug: `synthetic-${id}-${i}`,
			url,
			kitClicks: 10,
			clickToDeliveryRate: 0.01,
			clickToOpenRate: 0.02,
			shortlinkClicks: 8,
			signups: 2,
			purchases: 1,
			revenue: 199,
		})),
		totalSignups: 2 * links,
		totalPurchases: links,
		totalRevenue: 199 * links,
		clickToPurchaseRate: 0.1,
	}
}

const kitReport = (campaigns = [campaign(1), campaign(2)]) => ({
	configured: true,
	totalBroadcasts: campaigns.length,
	totalRecipients: campaigns.length * 1000,
	totalRevenue: campaigns.reduce((sum, c) => sum + c.totalRevenue, 0),
	campaigns,
})

const capture = (scopes: Scope[], read = async () => kitReport()) =>
	captureSnapshots({ scopes, read, limit: 20, asOf })

describe('capture', () => {
	it('produces an archive the owned report serves back for every captured scope', async () => {
		const scopes = fullScopes(['synthetic-product'])
		const snapshots = await capture(scopes)
		const env = { AIH_REPORTING_KIT_HISTORY_JSON: JSON.stringify(snapshots) }
		for (const scope of scopes) {
			const report = await getOwnedNewsletterReport({
				...scope,
				env,
				now,
				fetcher: vi.fn(async () => {
					throw new Error('no network in tests')
				}),
			})
			expect(report.historical).toMatchObject({
				status: 'available',
				data: { asOf, ...scope, data: kitReport() },
			})
		}
	})

	it('reads each scope with its own mode, range, product and limit', async () => {
		const read = vi.fn(async () => kitReport())
		const scopes: Scope[] = [
			{ mode: 'standard', range: 'all' },
			{ mode: 'strict', range: '30d', productId: 'synthetic-product' },
		]
		await capture(scopes, read)
		expect(read.mock.calls).toEqual(scopes.map((scope) => [scope, 20]))
	})

	it.each([
		['the drovr report', { provider: 'drovr', historical: {} }],
		['an unconfigured Kit', { ...kitReport([]), configured: false }],
		['nothing', null],
	])('refuses %s instead of archiving it', async (_, data) => {
		await expect(
			capture([{ mode: 'standard', range: 'all' }], async () => data as never),
		).rejects.toThrow('did not return a configured Kit report')
	})

	it('refuses data the archive schema would reject, without echoing values', async () => {
		const bad = { ...campaign(1), recipients: 10.5 }
		const error = await capture([{ mode: 'standard', range: 'all' }], async () =>
			kitReport([bad]),
		).catch((caught: Error) => caught)
		expect(error).toBeInstanceOf(Error)
		expect((error as Error).message).toMatch(/HistoricalReports/)
		expect((error as Error).message).toContain('recipients')
		expect((error as Error).message).not.toContain('Synthetic subject')
	})

	it('refuses more scopes than the archive holds', async () => {
		const products = Array.from({ length: 9 }, (_, i) => `product-${i}`)
		await expect(capture(fullScopes(products))).rejects.toThrow(
			'HistoricalReports',
		)
	})
})

describe('scope selection', () => {
	it('full covers every range for both modes, plus strict per product', () => {
		expect(fullScopes([])).toHaveLength(10)
		const scopes = fullScopes(['p1'])
		expect(scopes).toHaveLength(15)
		for (const range of ['24h', '7d', '30d', '90d', 'all'])
			expect(scopes).toEqual(
				expect.arrayContaining([
					{ mode: 'standard', range },
					{ mode: 'strict', range },
					{ mode: 'strict', range, productId: 'p1' },
				]),
			)
	})

	it.each([
		['2026-10-26T00:00:00Z', '24h'],
		['2026-11-01T12:00:00Z', '7d'],
		['2026-11-02T00:00:00Z', '30d'],
		['2026-12-20T00:00:00Z', '90d'],
		['2027-03-01T00:00:00Z', 'all'],
	])('at %s the C5 range is %s', (at, range) => {
		expect(c5Range(Date.parse(at))).toBe(range)
	})

	it('fallback is all and the C5 range for both modes', () => {
		expect(fallbackScopes(now, [])).toEqual([
			{ mode: 'standard', range: 'all' },
			{ mode: 'strict', range: 'all' },
			{ mode: 'standard', range: '7d' },
			{ mode: 'strict', range: '7d' },
		])
		// Once C5 is older than 90 days its range collapses into all.
		expect(fallbackScopes(Date.parse('2027-03-01T00:00:00Z'), [])).toHaveLength(
			2,
		)
	})

	it('--scopes selects exactly the listed scopes', () => {
		const args = parseSnapshotArgs([
			'--out',
			'/x.json',
			'--scopes',
			'standard:all,strict:7d@product-a',
		])
		expect(selectScopes(args, now)).toEqual([
			{ mode: 'standard', range: 'all' },
			{ mode: 'strict', range: '7d', productId: 'product-a' },
		])
		expect(
			selectScopes(
				parseSnapshotArgs(['--out', '/x.json', '--scopes', 'fallback']),
				now,
			),
		).toEqual(fallbackScopes(now, []))
		expect(selectScopes(parseSnapshotArgs(['--out', '/x.json']), now)).toEqual(
			fullScopes([]),
		)
	})

	it('never selects a scope twice, which would make it unreadable', () => {
		const explicit = parseSnapshotArgs([
			'--out',
			'/x.json',
			'--scopes',
			'standard:all,standard:all,strict:7d@p,strict:7d@p',
		])
		expect(selectScopes(explicit, now)).toEqual([
			{ mode: 'standard', range: 'all' },
			{ mode: 'strict', range: '7d', productId: 'p' },
		])
		const repeated = parseSnapshotArgs([
			'--out',
			'/x.json',
			'--product',
			'p',
			'--product',
			'p',
		])
		expect(selectScopes(repeated, now)).toEqual(fullScopes(['p']))
	})

	it.each([
		[[], '--out <path> is required'],
		[['--out', '/x', '--scopes', 'standard:1y'], 'Unknown scope'],
		[['--out', '/x', '--scopes', 'standard:all@p'], 'Only strict scopes'],
		[['--out', '/x', '--scopes', 'standard:all', '--product', 'p'], 'inside --scopes'],
		[['--out', '/x', '--limit', '0'], '--limit'],
		[['--out', '/x', '--bogus'], 'Unknown argument'],
		[['--out'], '--out needs a value'],
	])('rejects %j', (argv, message) => {
		expect(() => parseSnapshotArgs(argv)).toThrow(message)
	})
})

describe('size budget', () => {
	it('keeps a capture that fits', async () => {
		const snapshots = await capture(fullScopes([]))
		expect(fitBudget(snapshots, fallbackScopes(now, []))).toEqual({
			ok: true,
			snapshots,
			fellBack: false,
		})
	})

	it('narrows an oversized full capture to the fallback scopes', async () => {
		const snapshots = await capture(fullScopes([]))
		const fallback = fallbackScopes(now, [])
		const budget = byteSize(snapshots) - 1
		const fit = fitBudget(snapshots, fallback, budget)
		expect(fit).toMatchObject({ ok: true, fellBack: true })
		if (!fit.ok) return
		expect(fit.snapshots.map(({ mode, range }) => ({ mode, range }))).toEqual(
			expect.arrayContaining(fallback),
		)
		expect(fit.snapshots).toHaveLength(fallback.length)
		expect(byteSize(fit.snapshots)).toBeLessThanOrEqual(budget)
	})

	it('writes nothing when even the narrowed or explicit capture is over', async () => {
		const snapshots = await capture(fullScopes([]))
		expect(fitBudget(snapshots, fallbackScopes(now, []), 10)).toMatchObject({
			ok: false,
		})
		expect(fitBudget(snapshots, null, byteSize(snapshots) - 1)).toEqual({
			ok: false,
			bytes: byteSize(snapshots),
		})
	})

	it('reports sizes and counts per snapshot, never report values', async () => {
		const snapshots = await capture([
			{ mode: 'strict', range: 'all', productId: 'synthetic-product' },
		])
		const lines = describeSnapshots(snapshots)
		expect(lines).toEqual([
			`strict all @synthetic-product: 2 campaigns, ${byteSize(snapshots[0])} bytes`,
			`total: 1 snapshots, ${byteSize(snapshots)} bytes (budget 40000)`,
		])
		expect(lines.join('\n')).not.toMatch(/Synthetic subject|aihero\.dev|199/)
	})
})

describe('--trim-links', () => {
	it('drops per-link rows, keeps campaign totals, and still parses', async () => {
		const snapshots = await capture(
			[{ mode: 'standard', range: 'all' }],
			async () => kitReport([campaign(1, 30), campaign(2, 30)]),
		)
		const trimmed = trimLinks(snapshots)
		expect(HistoricalReports.parse(JSON.parse(JSON.stringify(trimmed)))).toEqual(
			JSON.parse(JSON.stringify(trimmed)),
		)
		expect(JSON.stringify(trimmed)).not.toContain('kitLinks')
		expect(JSON.stringify(trimmed)).not.toContain('aihero.dev/s/')
		for (const [i, c] of trimmed[0]!.data.campaigns.entries()) {
			const original = snapshots[0]!.data.campaigns[i]!
			expect(c.shortlinks).toEqual([])
			expect(c).toMatchObject({
				broadcastId: original.broadcastId,
				recipients: original.recipients,
				totalClicks: original.totalClicks,
				totalSignups: original.totalSignups,
				totalPurchases: original.totalPurchases,
				totalRevenue: original.totalRevenue,
				clickToPurchaseRate: original.clickToPurchaseRate,
			})
		}
		expect(byteSize(trimmed) * 5).toBeLessThan(byteSize(snapshots))
	})
})

describe('Kit read memoization', () => {
	const kitUrl = 'https://api.kit.com/v4/broadcasts/stats?per_page=40'

	it('reads each Kit URL once and serves every caller the same body', async () => {
		const network = vi.fn(async () => new Response('{"broadcasts":[1]}'))
		const { fetch: fetcher, failedReads } = memoizeKitReads(network)
		const [a, b] = await Promise.all([fetcher(kitUrl), fetcher(kitUrl)])
		const c = await fetcher(kitUrl, { headers: { 'X-Kit-Api-Key': 'k' } })
		for (const response of [a, b, c])
			expect(await response.json()).toEqual({ broadcasts: [1] })
		expect(network).toHaveBeenCalledTimes(1)
		expect(failedReads()).toBe(0)
	})

	it('passes non-Kit and non-GET requests straight through', async () => {
		const network = vi.fn(async () => new Response('{}'))
		const { fetch: fetcher } = memoizeKitReads(network)
		await fetcher('https://drovr.example.test/receipts')
		await fetcher('https://drovr.example.test/receipts')
		await fetcher(kitUrl, { method: 'POST' })
		await fetcher(kitUrl, { method: 'POST' })
		expect(network).toHaveBeenCalledTimes(4)
	})

	it('counts every failed Kit read, so a swallowed click failure still blocks the write', async () => {
		const network = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockRejectedValueOnce(new Error('socket hang up'))
			.mockResolvedValue(new Response('{}', { status: 429 }))
		const { fetch: fetcher, failedReads } = memoizeKitReads(network)
		await expect(fetcher(kitUrl)).rejects.toThrow('socket hang up')
		expect(failedReads()).toBe(1)
		expect((await fetcher(kitUrl)).status).toBe(429)
		expect((await fetcher(kitUrl)).status).toBe(429)
		expect(network).toHaveBeenCalledTimes(2)
		expect(failedReads()).toBe(2)
	})
})
