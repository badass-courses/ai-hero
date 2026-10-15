import { describe, expect, it } from 'vitest'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import {
	runContactProfileSync,
	type ContactProfileSnapshot,
} from './drovr-contact-profile-sync'
import { queueContactSyncBulk } from './contact-sync-bulk'
import {
	bulkPaceDecision,
	restatementPlan,
	syncDeliveryLane,
} from './contact-sync-deltas'
import { runContactSyncReconcile } from './contact-sync-reconcile'
import {
	runContactSyncBackfill,
	type BackfillPorts,
} from './contact-sync-backfill'
import {
	createMemoryValuePathLinkAnchorStore,
	resolveValuePathLinkAnchor,
} from './value-path-link-anchor'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

// Synthetic populations and a seeded generator make failures reproducible.
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
	offers: [{ journeyId: 'offer', couponId: 'coupon-0', variables: {} }],
})

describe('contact sync generated sequence model', () => {
	it('coupons, changes, rotations, reconcile, restatement, crash and retry preserve the contract', async () => {
		for (let seed = 1; seed <= 24; seed++) {
			const random = generator(seed)
			const store = createMemoryContactProfileVersionStore({
				now: () => new Date(start).toISOString(),
			})
			// Begin with a legacy digest. Coupon and restatement must not reinterpret it.
			await store.versionFor('contact', 'legacy-combined-digest')
			await store.acknowledge('contact', 1)
			let state = snapshot()
			let clock = start
			let crash = true
			const durable = new Map<string, string>()
			const bulk: DrovrShadowEvent[] = []
			const live: DrovrShadowEvent[] = []
			const sync = async (
				reason: 'offer-issued' | 'journey-entered' | 'reconcile' | 'restate',
			) => {
				const memo = new Map<string, unknown>()
				const run = () =>
					runContactProfileSync({
						event: { data: { contactId: 'contact', reason } },
						env: { AIH_DROVR_PROFILE_SYNC: 'true' },
						step: {
							run: async (id, callback) => {
								if (!memo.has(id)) memo.set(id, await callback())
								return memo.get(id)
							},
							sendEvent: async () => {},
						},
						readSnapshot: async () => structuredClone(state),
						versionFor: store.versionFor,
						currentVersion: store.currentFor,
						acknowledge: store.acknowledge,
						ownedPath: async () => undefined,
						onSendingJourney: async () => true,
						birth: async () => {},
						deliver: async (events) => {
							if (syncDeliveryLane(reason) === 'live') {
								live.push(...events)
								return { accepted: events.length, rejected: 0 }
							}
							return queueContactSyncBulk(events, {
								capture: async (entries) => {
									for (const entry of entries) {
										const body = JSON.stringify(entry.body)
										if (durable.has(entry.idempotencyKey))
											expect(body).toBe(durable.get(entry.idempotencyKey))
										durable.set(entry.idempotencyKey, body)
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
			// An entirely legacy population must remain equal-version on a restatement.
			await sync('restate')
			expect((await store.currentFor('contact'))!.profileVersion).toBe(1)
			expect(bulk.map((event) => event.type)).toEqual([
				'contact.profile.updated',
			])
			expect(bulk[0]!.idempotencyKey).toBe('profile:contact:1:restate:2032-01')
			expect(bulk[0]!.occurredAt).toBe(state.occurredAt)
			for (let index = 0; index < 48; index++) {
				clock += 60000
				state.occurredAt = new Date(clock).toISOString()
				const before = (await store.currentFor('contact'))!.profileVersion
				const oldBulk = bulk.length
				switch (random() % 6) {
					case 0: // Coupon values are independent, at the current profile version.
						state.offers[0]!.couponId = `coupon-${seed}-${index}`
						await sync('offer-issued')
						expect((await store.currentFor('contact'))!.profileVersion).toBe(
							before,
						)
						expect(bulk.length).toBe(oldBulk)
						expect(live.at(-1)!.type).toBe('contact.offer.issued')
						break
					case 1:
						state.profile.firstName = `Name ${seed}-${index}`
						await sync('journey-entered')
						expect((await store.currentFor('contact'))!.profileVersion).toBe(
							before + 1,
						)
						expect(bulk.slice(oldBulk).map((event) => event.type)).toEqual([
							'contact.profile.updated',
							'contact.links.issued',
							'contact.offer.issued',
						])
						break
					case 2: // A changed validity window is a real link delta.
						state.links[0]!.issuedAt = new Date(clock).toISOString()
						state.links[0]!.expiresAt = new Date(
							clock + 120 * 86400000,
						).toISOString()
						await sync('journey-entered')
						expect((await store.currentFor('contact'))!.profileVersion).toBe(
							before + 1,
						)
						break
					case 3:
						if (
							(await store.currentFor('contact'))!.contentHash.startsWith('v2:')
						) {
							await sync('reconcile')
							expect(bulk.length).toBe(oldBulk)
						}
						break
					case 4:
						state.profile.firstName = `Crash ${seed}-${index}`
						crash = true
						await sync('journey-entered')
						expect(crash).toBe(false)
						break
					case 5: // A dungeon-style re-push does not manufacture a version.
						await sync('offer-issued')
						expect((await store.currentFor('contact'))!.profileVersion).toBe(
							before,
						)
				}
			}
			const links = bulk.filter(
				(event) => event.type === 'contact.links.issued',
			)
			expect(new Set(links.map((event) => event.idempotencyKey)).size).toBe(
				links.length,
			)
			// A changed new-format row encountered by the restater takes the delta path.
			state.profile.firstName = 'Changed during restatement'
			const before = (await store.currentFor('contact'))!.profileVersion
			const offset = bulk.length
			await sync('restate')
			expect((await store.currentFor('contact'))!.profileVersion).toBe(
				before + 1,
			)
			expect(bulk.slice(offset).map((event) => event.type)).toEqual([
				'contact.profile.updated',
				'contact.links.issued',
				'contact.offer.issued',
			])
			// Clock model for all bulk/retry starts. Coupons never acquire this slot.
			let nextAt = 0
			const starts: number[] = []
			for (let now = 0; now < 180000; now += 17) {
				const result = bulkPaceDecision(nextAt, now)
				expect(syncDeliveryLane('coupon.issued')).toBe('live')
				if (result.action === 'send') {
					starts.push(now)
					nextAt = result.nextAt
				}
			}
			for (const at of starts)
				expect(
					starts.filter((value) => value >= at && value < at + 60000).length,
				).toBeLessThanOrEqual(300)
		}
	})

	it('confirms an all-legacy population within two months, without version bumps or links', async () => {
		const store = createMemoryContactProfileVersionStore()
		const due = Array.from({ length: 73 }, (_, i) => `contact-${i}`)
		for (const id of due) await store.versionFor(id, 'legacy')
		const versions = new Map(
			await Promise.all(
				due.map(
					async (id) =>
						[id, (await store.currentFor(id))!.profileVersion] as const,
				),
			),
		)
		const quota = restatementPlan(due.length, start + 31 * 86400000).contacts
		let ticks = 0
		while (due.length) {
			due.splice(0, quota)
			ticks++
		}
		expect(ticks * 15 * 60000).toBeLessThan(60 * 86400000)
		for (const [id, version] of versions)
			expect((await store.currentFor(id))!.profileVersion).toBe(version)
	})

	it('a no-change reconcile still posts an honest heartbeat every quarter hour', async () => {
		const heartbeats: { at: number; through: string }[] = []
		let watermark: string | undefined
		for (let tick = 0; tick < 12; tick++) {
			const at = start + tick * 15 * 60000
			await runContactSyncReconcile({
				now: () => new Date(at),
				readWatermark: async () => watermark,
				scanChanges: async () => [],
				rotatedContacts: async () => [],
				syncContact: async () => 'skipped',
				resendStops: async () => {},
				heartbeat: async (through) => {
					heartbeats.push({ at, through })
				},
				writeWatermark: async (value) => {
					watermark = value
				},
			})
		}
		expect(heartbeats).toHaveLength(12)
		for (const beat of heartbeats)
			expect(beat.at - Date.parse(beat.through)).toBeLessThan(3600000)
	})

	it('dry-run counts without writes; the first apply is one contact and never self-continues', async () => {
		const rows = Array.from({ length: 7 }, (_, i) => ({
			id: `row-${i}`,
			contactId: `contact-${i}`,
			eventType: 'journey.owner.assigned',
			providerEventId: `drovr-owner:contact-${i}:value-path-skills-course`,
			occurredAt: new Date(start).toISOString(),
		}))
		const sent: unknown[] = []
		let versions = 0
		let snapshots = 0
		const ports: BackfillPorts = {
			now: () => start,
			scanEvents: async ({ eventType, limit }) =>
				eventType === 'journey.owner.assigned' ? rows.slice(0, limit) : [],
			snapshot: async () => {
				snapshots++
				return { ...snapshot(), links: [], offers: [] }
			},
			versionFor: async () => {
				versions++
				return {
					profileVersion: 1,
					since: new Date(start).toISOString(),
					acknowledged: false,
				}
			},
			liveStopFacts: async () => [],
		}
		const args = {
			ports,
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			step: {
				run: async (_id: string, fn: () => Promise<unknown>) => fn(),
				sendEvent: async (_id: string, payload: unknown) => {
					sent.push(payload)
				},
			},
		}
		expect(
			await runContactSyncBackfill({
				...args,
				event: { data: { dryRun: true } },
			}),
		).toEqual({ status: 'dry-run', rows: 7 })
		expect([versions, snapshots, sent.length]).toEqual([0, 0, 0])
		await expect(
			runContactSyncBackfill({ ...args, event: { data: {} } }),
		).rejects.toThrow('BackfillCanary:')
		expect(
			await runContactSyncBackfill({
				...args,
				event: { data: { canary: true, dryRunCount: 7 } },
			}),
		).toMatchObject({ status: 'paused', contacts: 1, pages: 1 })
		expect([versions, snapshots, sent.length]).toEqual([1, 1, 1])
	})

	it('an unavailable durable write cannot publish or vouch for a delta', async () => {
		let published = false
		await expect(
			queueContactSyncBulk([], {
				capture: async () => ({ status: 'unavailable' }),
				send: async () => {
					published = true
				},
			}),
		).rejects.toThrow('SyncOutbox:')
		expect(published).toBe(false)
	})

	it('every generated rotated anchor keeps at least thirty days of life', async () => {
		const store = createMemoryValuePathLinkAnchorStore()
		const key = {
			contactId: 'contact',
			valuePathSlug: 'path',
			emailResourceId: 'message',
			fingerprint: 'inputs',
		}
		for (let day = 0; day < 721; day++) {
			const now = start + day * 86400000
			const anchor = await resolveValuePathLinkAnchor({
				store,
				key,
				now: new Date(now).toISOString(),
			})
			expect(Date.parse(anchor!.expiresAt) - now).toBeGreaterThanOrEqual(
				30 * 86400000,
			)
		}
	})
})
