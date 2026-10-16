import { expect, it, vi } from 'vitest'
import { BACKFILL_DUNGEON_FLAG, BACKFILL_DUNGEON_CONFIRMATION } from './contact-sync-backfill-dungeon'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import {
	runContactProfileSync,
	legacyContactProfileContentHash,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import { queueContactSyncBulk } from './contact-sync-bulk'
import { drovrOutboxDedupeKey, type DrovrOutboxRow } from './drovr-outbox'
import {
	runContactSyncBackfill,
	type BackfillPorts,
} from './contact-sync-backfill'
import { approvalDigest } from './contact-sync-backfill-approval'
import {
	createMemoryValuePathLinkAnchorStore,
	resolveValuePathLinkAnchor,
} from './value-path-link-anchor'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

function generator(seed: number) {
	return () => {
		seed = (seed * 1664525 + 1013904223) >>> 0
		return seed
	}
}
const start = Date.parse('2032-01-01T00:00:00.000Z')
const snapshot = (): ContactProfileSnapshot => ({
	occurredAt: new Date(start).toISOString(),
	profile: { email: 'learner@example.test', firstName: 'Test', holds: [] },
	links: [
		{
			journeyId: 'journey',
			emailKey: 'message',
			issuedAt: new Date(start).toISOString(),
			expiresAt: new Date(start + 120 * 86400000).toISOString(),
			variables: { url: 'https://example.test/a' },
			sendTimeFields: [],
		},
	],
	offers: [
		{
			journeyId: 'offer',
			couponId: 'coupon-0',
			issuedAt: new Date(start).toISOString(),
			variables: {},
		},
	],
})

it('generated legacy OFF histories preserve versions, immutable queued links and independent coupon keys across crash/retry', async () => {
	for (let seed = 1; seed <= 24; seed++) {
		const random = generator(seed)
		let clock = start
		const state = snapshot()
		const store = createMemoryContactProfileVersionStore({
			now: () => new Date(clock).toISOString(),
		})
		await store.versionFor('contact', legacyContactProfileContentHash(state))
		await store.acknowledge('contact', 1)
		let crash = true
		const durable = new Map<string, string>()
		const target = 'synthetic-history-receiver'
		const receipts = new Map<string, DrovrOutboxRow>()
		const bulk: DrovrShadowEvent[] = []
		const live: DrovrShadowEvent[] = []
		const sync = async (
			reason: 'offer-issued' | 'journey-entered' | 'reconcile' | 'restate',
		) => {
			const memo = new Map<string, unknown>()
			const run = () =>
				runContactProfileSync({
					// Pinned reader-first OFF model. Atomic frozen ON histories
					// and SDK failed-write freshness have separate SQL/model tests.
					profileAckEnabled: async () => false,
					event: { data: { contactId: 'contact', reason } },
					env: { AIH_DROVR_PROFILE_SYNC: 'true' },
					step: {
						run: async (id, fn) => {
							if (!memo.has(id)) memo.set(id, await fn())
							return memo.get(id)
						},
						sendEvent: async () => {},
					},
					readSnapshot: async () => structuredClone(state),
					versionFor: store.versionFor,
					currentVersion: store.currentFor,
					acknowledge: store.acknowledge,
					acknowledgeLegacy: store.acknowledgeLegacy,
					ownedPath: async () => undefined,
					onSendingJourney: async () => true,
					birth: async () => {},
					deliver: async (events) => {
						if (reason === 'offer-issued') {
							live.push(...events)
							return { accepted: events.length, rejected: 0 }
						}
						return queueContactSyncBulk(events, {
							capture: async (entries) => {
								for (const entry of entries) {
									const bytes = JSON.stringify(entry.body)
									if (durable.has(entry.idempotencyKey))
										expect(bytes).toBe(durable.get(entry.idempotencyKey))
									durable.set(entry.idempotencyKey, bytes)
									const key = drovrOutboxDedupeKey(target, entry)
									if (!receipts.has(key)) receipts.set(key, { ...entry, id: key, target, dedupeKey: key, status: 'pending', attempts: 0, lastStatus: null, lastError: null, firstFailedAt: new Date(clock).toISOString(), nextAttemptAt: new Date(clock).toISOString(), lastAttemptAt: null, deliveredAt: null, releasedAt: null, createdAt: new Date(clock).toISOString() })
								}
								return { status: 'outboxed', count: entries.length }
							},
							send: async (envelopes) => {
								if (crash) {
									crash = false
									throw new Error('synthetic crash after durable write')
								}
								bulk.push(
									...envelopes.flatMap((envelope) => envelope.data.events),
								)
								// This model drains the physical receiver after publish,
								// before the producer's fresh proof. Queue-only no-ACK
								// behavior is tested independently with pending rows.
								for (const event of envelopes.flatMap(envelope => envelope.data.events)) {
									const row = [...receipts.values()].find(row => row.idempotencyKey === event.idempotencyKey)!
									row.status = 'delivered'; row.lastStatus = 202; row.deliveredAt = new Date(clock).toISOString()
								}
							},
						})
					},
				})
			try {
				return await run()
			} catch (error) {
				expect(String(error)).toContain('synthetic crash')
				return run()
			}
		}
		expect(await sync('journey-entered')).toEqual({
			status: 'skipped',
			reason: 'hash-migrated',
		})
		expect(bulk).toEqual([])
		clock += 35 * 86400000
		state.occurredAt = new Date(clock).toISOString()
		await sync('restate')
		expect((await store.currentFor('contact'))!.profileVersion).toBe(1)
		expect(bulk.map((event) => event.type)).toEqual(['contact.profile.updated'])
		for (let index = 0; index < 48; index++) {
			clock += 60000
			state.occurredAt = new Date(clock).toISOString()
			const before = (await store.currentFor('contact'))!.profileVersion
			const offset = bulk.length
			switch (random() % 6) {
				case 0: {
					const previous = live.at(-1)?.idempotencyKey
					state.offers[0] = {
						...state.offers[0]!,
						couponId: `coupon-${seed}-${index}`,
						issuedAt: state.occurredAt,
					}
					await sync('offer-issued')
					expect((await store.currentFor('contact'))!.profileVersion).toBe(
						before,
					)
					expect(bulk.length).toBe(offset)
					expect(live.at(-1)!.idempotencyKey).not.toBe(previous)
					expect(live.at(-1)!.occurredAt).toBe(state.occurredAt)
					break
				}
				case 1:
					state.profile.firstName = `Name ${seed}-${index}`
					await sync('journey-entered')
					expect((await store.currentFor('contact'))!.profileVersion).toBe(
						before + 1,
					)
					expect(bulk.slice(offset).map((event) => event.type)).toEqual([
						'contact.profile.updated',
						'contact.links.issued',
					])
					break
				case 2:
					state.links[0]!.issuedAt = state.occurredAt
					state.links[0]!.expiresAt = new Date(
						clock + 120 * 86400000,
					).toISOString()
					await sync('journey-entered')
					expect((await store.currentFor('contact'))!.profileVersion).toBe(
						before + 1,
					)
					break
				case 3:
					await sync('reconcile')
					expect(bulk.length).toBe(offset)
					break
				case 4:
					state.profile.firstName = `Crash ${seed}-${index}`
					crash = true
					await sync('journey-entered')
					expect(crash).toBe(false)
					break
				case 5:
					await sync('offer-issued')
					expect((await store.currentFor('contact'))!.profileVersion).toBe(
						before,
					)
			}
		}
		const links = bulk.filter((event) => event.type === 'contact.links.issued')
		expect(new Set(links.map((event) => event.idempotencyKey)).size).toBe(
			links.length,
		)
		expect(bulk.some((event) => event.type === 'contact.offer.issued')).toBe(
			false,
		)
	}
})

it('dry count is five aggregate reads; canary proves the count, then grants only the exact next manual cursor', async () => {
	const grants = new Map<string, string>()
	let issued = 0
	const countEvents = vi.fn(async (type: string) =>
		type === 'journey.owner.assigned' ? 1 : 0,
	)
	const scanEvents = vi.fn(
		async ({ eventType, afterId }: { eventType: string; afterId?: string }) =>
			eventType === 'journey.owner.assigned' && !afterId
				? [
						{
							id: 'row',
							contactId: 'contact',
							eventType,
							providerEventId: 'drovr-owner:contact:value-path-skills-course',
							occurredAt: new Date(start).toISOString(),
						},
					]
				: [],
	)
	const versions = createMemoryContactProfileVersionStore()
	const ports: BackfillPorts = {
		persistEvents: async () => {},
		now: () => start,
		countEvents,
		scanEvents,
		versionFor: versions.versionFor,
		snapshot: async () => snapshot(),
		liveStopFacts: async () => [],
		approvals: {
			issue: async (binding) => {
				const token = `grant-${++issued}`
				grants.set(token, approvalDigest(binding))
				return token
			},
			consume: async (token, binding) => {
				if (grants.get(token) !== approvalDigest(binding)) return false
				grants.delete(token)
				return true
			},
		},
	}
	const sendEvent = vi.fn(async (_id: string, _payload: unknown) => {})
	const step = {
		run: async (_id: string, fn: () => Promise<unknown>) => fn(),
		sendEvent,
	}
	const run = (
		data: Parameters<typeof runContactSyncBackfill>[0]['event']['data'],
	) =>
		runContactSyncBackfill({
			event: { data },
			step,
			ports,
			env: { AIH_DROVR_PROFILE_SYNC: 'true', [BACKFILL_DUNGEON_FLAG]: BACKFILL_DUNGEON_CONFIRMATION },
		})
	expect(await run({ dryRun: true })).toEqual({ status: 'dry-run', rows: 1 })
	expect(countEvents).toHaveBeenCalledTimes(5)
	expect(scanEvents).not.toHaveBeenCalled()
	expect(grants.size).toBe(0)
	expect(sendEvent).not.toHaveBeenCalled()
	await expect(
		run({
			canary: true,
			dryRunCount: 0,
			canaryConfirmed: true,
			cursor: { phase: 'owners' },
		}),
	).rejects.toMatchObject({ name: 'NonRetriableError' })
	await expect(run({ canary: true, dryRunCount: 0 })).rejects.toThrow(
		'BackfillCountChanged:',
	)
	const canary = await run({ canary: true, dryRunCount: 1 })
	expect(canary).toMatchObject({ status: 'paused', contacts: 1 })
	if (canary.status !== 'paused') throw new Error('expected canary')
	const data = {
		canary: true,
		dryRunCount: 1,
		canaryConfirmed: true,
		approvalToken: canary.approvalToken,
		cursor: canary.cursor,
		maxPages: 1,
	}
	await expect(
		run({ ...data, cursor: { ...canary.cursor, afterId: 'forged' } }),
	).rejects.toThrow('BackfillApproval:')
	const calls = countEvents.mock.calls.length
	await run(data)
	expect(countEvents.mock.calls.length).toBe(calls)
	await expect(run(data)).rejects.toThrow('BackfillApproval:')
	for (const [, envelopes] of sendEvent.mock.calls)
		expect(JSON.stringify(envelopes)).not.toContain('backfill-requested')
})

it('real anchor rotation maintains the receiving-side expiry margin without an unwired link filter', async () => {
	const store = createMemoryValuePathLinkAnchorStore()
	const key = {
		contactId: 'contact',
		valuePathSlug: 'path',
		emailResourceId: 'email',
		fingerprint: 'input',
	}
	let first: string | undefined
	let rotated = false
	for (let day = 0; day < 240; day++) {
		const now = start + day * 86400000
		const window = await resolveValuePathLinkAnchor({
			store,
			key,
			now: new Date(now).toISOString(),
		})
		expect(window).toBeDefined()
		expect(Date.parse(window!.expiresAt) - now).toBeGreaterThan(30 * 86400000)
		first ??= window!.issuedAt
		if (window!.issuedAt !== first) rotated = true
	}
	expect(rotated).toBe(true)
})
