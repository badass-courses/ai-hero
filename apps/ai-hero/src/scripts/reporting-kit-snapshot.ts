import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { FEATURED_PROMO } from '@/components/navigation/promo-config'
import type { AnalyticsRange } from '@/lib/analytics/types'
import { HistoricalReports, type HistoricalReport } from '@/lib/reporting-owned'

/**
 * One-off: freeze today's Kit-backed newsletter report into the array that
 * AIH_REPORTING_KIT_HISTORY_JSON parses, before AIH_REPORTING_OFF_KIT_ENABLED
 * flips. Read-only against Kit and the database. Writes the JSON to --out,
 * mode 0600, and never prints a value: only scopes, counts and byte sizes.
 *
 *   pnpm reporting:kit-snapshot --out <path>
 *   pnpm reporting:kit-snapshot --out <path> --scopes fallback --trim-links
 *   pnpm reporting:kit-snapshot --out <path> --product <productId>
 *
 * --scopes full (default): every range for standard and strict, plus strict
 *   per --product. Over budget, it keeps the fallback subset and says so.
 * --scopes fallback: `all` and the C5 range, both modes.
 * --scopes standard:all,strict:30d,strict:all@<productId>: exactly these.
 * --trim-links drops kitLinks and empties shortlinks on every campaign.
 *
 * Credentials come only from the environment, under the app's own names:
 * CONVERTKIT_V4_API_KEY and DATABASE_URL.
 */

type Mode = HistoricalReport['mode']
export type Scope = { mode: Mode; range: AnalyticsRange; productId?: string }

// Vercel caps the whole env near 64 KB and AI Hero already holds ~48 vars.
export const SNAPSHOT_BUDGET_BYTES = 40_000
const RANGES = ['24h', '7d', '30d', '90d', 'all'] as const
const ROLLING_HOURS = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 }

/** The smallest rolling range that reaches back to C5 enrollment opening. */
export function c5Range(
	now: number,
	opensAt = FEATURED_PROMO.startsAt!,
): AnalyticsRange {
	const opened = Date.parse(opensAt)
	for (const range of ['24h', '7d', '30d', '90d'] as const)
		if (now - ROLLING_HOURS[range] * 60 * 60 * 1000 <= opened) return range
	return 'all'
}

function scopesFor(ranges: readonly AnalyticsRange[], productIds: string[]) {
	return [...new Set(ranges)].flatMap((range): Scope[] => [
		{ mode: 'standard', range },
		{ mode: 'strict', range },
		...productIds.map((productId) => ({
			mode: 'strict' as const,
			range,
			productId,
		})),
	])
}

export const fullScopes = (productIds: string[]) => scopesFor(RANGES, productIds)

export const fallbackScopes = (now: number, productIds: string[]) =>
	scopesFor(['all', c5Range(now)], productIds)

export function parseScopeList(list: string): Scope[] {
	return list.split(',').map((entry) => {
		const match = /^(standard|strict):(24h|7d|30d|90d|all)(?:@(.+))?$/.exec(
			entry.trim(),
		)
		if (!match) throw new Error(`Unknown scope "${entry}"`)
		const [, mode, range, productId] = match
		if (productId && mode !== 'strict')
			throw new Error(`Only strict scopes take a productId: "${entry}"`)
		return {
			mode: mode as Mode,
			range: range as AnalyticsRange,
			...(productId ? { productId } : {}),
		}
	})
}

export type SnapshotArgs = {
	out: string
	scopes: 'full' | 'fallback' | Scope[]
	productIds: string[]
	trimLinks: boolean
	limit: number
}

export function parseSnapshotArgs(argv: string[]): SnapshotArgs {
	const args: SnapshotArgs = {
		out: '',
		scopes: 'full',
		productIds: [],
		trimLinks: false,
		limit: 20,
	}
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]
		const value = () => {
			const next = argv[++i]
			if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`)
			return next
		}
		if (flag === '--out') args.out = value()
		else if (flag === '--product') args.productIds.push(value())
		else if (flag === '--trim-links') args.trimLinks = true
		else if (flag === '--limit') {
			args.limit = Number(value())
			if (!Number.isInteger(args.limit) || args.limit < 1)
				throw new Error('--limit must be a positive integer')
		} else if (flag === '--scopes') {
			const list = value()
			args.scopes =
				list === 'full' || list === 'fallback' ? list : parseScopeList(list)
		} else throw new Error(`Unknown argument "${flag}"`)
	}
	if (!args.out) throw new Error('--out <path> is required')
	if (Array.isArray(args.scopes) && args.productIds.length > 0)
		throw new Error('Name products inside --scopes as strict:<range>@<id>')
	return args
}

export function selectScopes(args: SnapshotArgs, now: number): Scope[] {
	if (Array.isArray(args.scopes)) return args.scopes
	return args.scopes === 'fallback'
		? fallbackScopes(now, args.productIds)
		: fullScopes(args.productIds)
}

const sameScope = (a: Scope, b: Scope) =>
	a.mode === b.mode && a.range === b.range && a.productId === b.productId

export type Reader = (scope: Scope, limit: number) => Promise<unknown>

/** Reads each scope in turn and refuses anything but a configured Kit report. */
export async function captureSnapshots(args: {
	scopes: Scope[]
	read: Reader
	limit: number
	asOf: string
}): Promise<HistoricalReport[]> {
	const snapshots: unknown[] = []
	for (const scope of args.scopes) {
		const data = await args.read(scope, args.limit)
		if (
			!data ||
			typeof data !== 'object' ||
			'provider' in data ||
			!('configured' in data) ||
			data.configured !== true
		)
			throw new Error(
				`${label(scope)} did not return a configured Kit report; is CONVERTKIT_V4_API_KEY set?`,
			)
		snapshots.push({ asOf: args.asOf, ...scope, data })
	}
	const parsed = HistoricalReports.safeParse(snapshots)
	if (!parsed.success)
		throw new Error(
			`Capture does not match HistoricalReports: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')} (${issue.code})`)
				.join('; ')}`,
		)
	return parsed.data
}

/** Keeps campaign totals; loses per-link Kit clicks and shortlink attribution rows. */
export function trimLinks(snapshots: HistoricalReport[]): HistoricalReport[] {
	return snapshots.map((snapshot) => ({
		...snapshot,
		data: {
			...snapshot.data,
			campaigns: snapshot.data.campaigns.map((campaign) => ({
				...campaign,
				kitLinks: undefined,
				shortlinks: [],
			})),
		},
	}))
}

export const byteSize = (value: unknown) =>
	Buffer.byteLength(JSON.stringify(value), 'utf8')

export type BudgetResult =
	| { ok: true; snapshots: HistoricalReport[]; fellBack: boolean }
	| { ok: false; bytes: number }

/** Over budget, a full capture narrows to the fallback scopes; nothing else shrinks. */
export function fitBudget(
	snapshots: HistoricalReport[],
	fallback: Scope[] | null,
	budget = SNAPSHOT_BUDGET_BYTES,
): BudgetResult {
	if (byteSize(snapshots) <= budget)
		return { ok: true, snapshots, fellBack: false }
	if (fallback) {
		const narrowed = snapshots.filter((snapshot) =>
			fallback.some((scope) => sameScope(scope, snapshot)),
		)
		if (byteSize(narrowed) <= budget)
			return { ok: true, snapshots: narrowed, fellBack: true }
		return { ok: false, bytes: byteSize(narrowed) }
	}
	return { ok: false, bytes: byteSize(snapshots) }
}

export function label(scope: Scope) {
	return `${scope.mode} ${scope.range}${scope.productId ? ` @${scope.productId}` : ''}`
}

/** Sizes and counts only: never subjects, URLs, or figures. */
export function describeSnapshots(snapshots: HistoricalReport[]): string[] {
	return [
		...snapshots.map(
			(snapshot) =>
				`${label(snapshot)}: ${snapshot.data.campaigns.length} campaigns, ${byteSize(snapshot)} bytes`,
		),
		`total: ${snapshots.length} snapshots, ${byteSize(snapshots)} bytes (budget ${SNAPSHOT_BUDGET_BYTES})`,
	]
}

/**
 * Every scope asks Kit for the same broadcasts, stats and clicks. Reading
 * each Kit URL once keeps the run under Kit's rate limit and gives every
 * snapshot the same Kit state.
 */
export function memoizeKitReads(fetcher: typeof fetch): typeof fetch {
	const cache = new Map<string, Promise<{ status: number; body: string }>>()
	return async (input, init) => {
		const url = input instanceof Request ? input.url : String(input)
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
		if (!url.startsWith('https://api.kit.com/') || method !== 'GET')
			return fetcher(input, init)
		let read = cache.get(url)
		if (!read) {
			read = fetcher(input, init).then(async (response) => ({
				status: response.status,
				body: await response.text(),
			}))
			cache.set(url, read)
			read.catch(() => cache.delete(url))
		}
		const { status, body } = await read
		return new Response(body, {
			status,
			headers: { 'content-type': 'application/json' },
		})
	}
}

async function main() {
	const args = parseSnapshotArgs(process.argv.slice(2))
	const now = Date.now()
	const scopes = selectScopes(args, now)
	// The readers return the drovr report while this is on; capture Kit's.
	process.env.AIH_REPORTING_OFF_KIT_ENABLED = 'false'
	globalThis.fetch = memoizeKitReads(globalThis.fetch)
	const [newsletter, { closeDatabasePool }] = await Promise.all([
		import('@/lib/analytics/providers/newsletter'),
		import('@/db/client'),
	])
	try {
		console.log(
			`capturing ${scopes.length} scopes, C5 range ${c5Range(now)}, limit ${args.limit}`,
		)
		const captured = await captureSnapshots({
			scopes,
			limit: args.limit,
			asOf: new Date(now).toISOString(),
			read: (scope, limit) =>
				scope.mode === 'standard'
					? newsletter.getEmailCampaignAttribution(scope.range, limit)
					: newsletter.getEmailCampaignAttributionStrict(scope.range, limit, {
							productId: scope.productId,
						}),
		})
		const shaped = args.trimLinks ? trimLinks(captured) : captured
		for (const line of describeSnapshots(shaped)) console.log(line)
		const fit = fitBudget(
			shaped,
			args.scopes === 'full' ? fallbackScopes(now, args.productIds) : null,
		)
		if (!fit.ok) {
			console.error(
				`over budget: ${fit.bytes} bytes. Nothing written. Retry with --scopes fallback${args.trimLinks ? ' or a narrower --scopes list' : ' --trim-links'}.`,
			)
			process.exitCode = 1
			return
		}
		if (fit.fellBack) {
			console.log('full capture is over budget; kept the fallback scopes:')
			for (const line of describeSnapshots(fit.snapshots)) console.log(line)
		}
		await writeFile(args.out, JSON.stringify(fit.snapshots), {
			mode: 0o600,
			flag: 'wx',
		})
		console.log(`wrote ${byteSize(fit.snapshots)} bytes to ${args.out}`)
	} finally {
		await closeDatabasePool()
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error) => {
		// First line only: a failed query lists its bound values on later lines.
		const message = error instanceof Error ? error.message : String(error)
		console.error(message.split('\n')[0]!.slice(0, 300))
		process.exitCode = 2
	})
}
