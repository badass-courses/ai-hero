import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import {
	runContactProfileSync,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import { runContactProfileSync as runMain } from './drovr-contact-profile-sync.main-09977e8f.fixture'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

const start = Date.parse('2032-01-01T00:00:00.000Z')
type Input = {
	reason: 'journey-entered' | 'offer-issued' | 'reconcile' | 'monthly-tick'
	change?: 'profile' | 'coupon'
	day?: number
}
async function exercise(
	main: boolean,
	input: Input[],
	readFlag?: () => Promise<boolean>,
) {
	let clock = start,
		version = 0,
		hash: string | undefined,
		acknowledged = false,
		since = new Date(start).toISOString()
	const snapshot: ContactProfileSnapshot = {
		occurredAt: since,
		profile: {
			email: 'rollout@example.test',
			firstName: 'Synthetic',
			holds: [],
		},
		links: [0, 1].map((n) => ({
			journeyId: 'synthetic-path',
			emailKey: `email-${n}`,
			issuedAt: since,
			expiresAt: '2032-05-01T00:00:00.000Z',
			variables: {},
			sendTimeFields: [],
		})),
		offers: [
			{ journeyId: 'synthetic-path', couponId: 'coupon-0', variables: {} },
		],
	}
	const seen = new Set<string>()
	let submitted = 0,
		withRepairAllowance = 0,
		repeatedCaptures = 0,
		coupon = 0
	const prefixes: {
		submitted: number
		withRepairAllowance: number
		repeatedCaptures: number
	}[] = []
	const capture = (key: string) => {
		if (seen.has(key)) repeatedCaptures++
		seen.add(key)
	}
	const proveDelivery = vi.fn(async () => {
		throw new Error('OFF attempted new receiver-proof completion')
	})
	const receipts = []
	for (const item of input) {
		clock = start + (item.day ?? 0) * 86400000
		snapshot.occurredAt = new Date(clock).toISOString()
		if (item.change === 'profile') snapshot.profile.firstName += ' changed'
		if (item.change === 'coupon')
			snapshot.offers[0]!.couponId = `coupon-${++coupon}`
		// A periodic directory tick is full reconciliation in pinned main,
		// and an explicit profile-only monthly restatement in the new planner.
		const reason =
			item.reason === 'monthly-tick'
				? main
					? 'reconcile'
					: 'restate'
				: item.reason
		const ports: Parameters<typeof runContactProfileSync>[0] = {
			event: { data: { contactId: 'contact-rollout-fixture', reason } },
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			step: {
				run: async (_id: string, action: () => Promise<unknown>) => action(),
				sendEvent: async () => {},
			},
			readSnapshot: async () => structuredClone(snapshot),
			versionFor: async (_contactId: string, nextHash: string) => {
				if (hash !== nextHash) {
					hash = nextHash
					version++
					since = new Date(clock).toISOString()
					acknowledged = false
				}
				return { profileVersion: version, since, acknowledged }
			},
			currentVersion: async () =>
				hash ? { profileVersion: version, since, acknowledged } : undefined,
			acknowledge: async () => {
				acknowledged = true
			},
			profileAckEnabled: readFlag,
			proveDelivery,
			deliver: async (events: DrovrShadowEvent[]) => {
				submitted += events.length
				withRepairAllowance += events.length
				for (const event of events) capture(event.idempotencyKey)
				// Conservative downstream allowance: count every current offer as
				// another send/capture after each new profile, even if its native
				// repair would already be delivered and deduplicated. Main's full
				// profile batch already includes the offers; never count them twice.
				if (
					!main &&
					events.some((event) => event.type === 'contact.profile.updated')
				) {
					withRepairAllowance += snapshot.offers.length
					for (const offer of snapshot.offers)
						capture(
							`offer:contact-rollout-fixture:${offer.couponId}:v${version}`,
						)
				}
				// Deliberately ZERO receiver accepts: pinned main's producer still
				// optimistically ACKs a successful queue handoff. OFF must too,
				// rather than submit unchanged versions over and over.
				return { accepted: 0, rejected: 0, deferred: [] }
			},
			ownedPath: async () => undefined,
			onSendingJourney: async () => true,
			birth: async () => {},
			now: () => clock,
		}
		receipts.push(await (main ? runMain : runContactProfileSync)(ports))
		prefixes.push({ submitted, withRepairAllowance, repeatedCaptures })
	}
	return { prefixes, receipts, proveDelivery }
}
it('pins the executable main oracle bytes, not a reimplemented optimistic-ACK model', () => {
	const source = readFileSync(
		new URL(
			'./drovr-contact-profile-sync.main-09977e8f.fixture.ts',
			import.meta.url,
		),
		'utf8',
	)
	expect(source.split('\n')[0]).toContain(
		'09977e8f0ead5d478e81d737926ade4843f16061',
	)
	expect(
		createHash('sha256')
			.update(source.split('\n').slice(1).join('\n'))
			.digest('hex'),
	).toBe('d8c6539437fbfa8c06e6d84bc28439039d0e1ee6b32be0dd57911f3d9e9f0002')
})
it.each(['false', 'missing', 'failed'] as const)(
	'OFF (%s) submits and re-captures no more than pinned main at EVERY fixture prefix',
	async (mode) => {
		const input: Input[] = [
			{ reason: 'journey-entered' },
			...Array.from({ length: 100 }, () => ({
				reason: 'journey-entered' as const,
			})),
			{ reason: 'offer-issued', change: 'coupon', day: 1 },
			{ reason: 'journey-entered', change: 'profile', day: 2 },
			...Array.from({ length: 10 }, () => ({
				reason: 'reconcile' as const,
				day: 3,
			})),
			{ reason: 'monthly-tick', day: 32 },
			{ reason: 'monthly-tick', day: 63 },
			...Array.from({ length: 100 }, () => ({
				reason: 'journey-entered' as const,
				day: 64,
			})),
		]
		const baseline = await exercise(true, input)
		const read =
			mode === 'missing'
				? undefined
				: async () => {
						if (mode === 'failed') throw new Error('synthetic flag outage')
						return false
					}
		const current = await exercise(false, input, read)
		for (let n = 0; n < input.length; n++) {
			expect(current.prefixes[n]!.submitted).toBeLessThanOrEqual(
				baseline.prefixes[n]!.submitted,
			)
			expect(current.prefixes[n]!.withRepairAllowance).toBeLessThanOrEqual(
				baseline.prefixes[n]!.withRepairAllowance,
			)
			expect(current.prefixes[n]!.repeatedCaptures).toBeLessThanOrEqual(
				baseline.prefixes[n]!.repeatedCaptures,
			)
		}
		expect(current.receipts[0]!.status).toBe('sent')
		expect(current.receipts[1]).toEqual({
			status: 'skipped',
			reason: 'unchanged',
		})
		expect(current.prefixes[100]).toEqual(current.prefixes[0])
		expect(baseline.prefixes[baseline.prefixes.length - 1]).toEqual({
			submitted: 60,
			withRepairAllowance: 60,
			repeatedCaptures: 48,
		})
		expect(current.prefixes[current.prefixes.length - 1]).toEqual({
			submitted: 9,
			withRepairAllowance: 13,
			repeatedCaptures: 2,
		})
		expect(current.proveDelivery).not.toHaveBeenCalled()
	},
)
it('a hung flag read fails OFF and cannot leave the same unchanged version in a resend loop', async () => {
	vi.useFakeTimers()
	try {
		const input: Input[] = [
			{ reason: 'journey-entered' },
			{ reason: 'journey-entered' },
		]
		const task = exercise(false, input, () => new Promise(() => {}))
		await vi.runAllTimersAsync()
		const current = await task
		expect(current.receipts[0]!.status).toBe('sent')
		expect(current.receipts[1]).toEqual({
			status: 'skipped',
			reason: 'unchanged',
		})
		expect(current.prefixes[0]).toEqual(current.prefixes[1])
		expect(current.proveDelivery).not.toHaveBeenCalled()
	} finally {
		vi.useRealTimers()
	}
})
