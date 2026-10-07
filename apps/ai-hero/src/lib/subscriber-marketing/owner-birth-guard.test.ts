import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DrovrEmailDeliveryRead } from './drovr-email-delivery'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
	mapDrovrShadowFact,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'
import {
	OWNER_BIRTH_GUARD_REPOST_CAP,
	OWNER_BIRTH_GUARD_PAGE_BUDGET_MS,
	runOwnerBirthGuard,
	type DrovrActorRead,
	type OwnerBirthGuardPorts,
} from './owner-birth-guard'
import type { ContactEventRecord } from './types'

vi.mock('@/env.mjs', () => ({ env: {} }))

const NOW = Date.parse('2026-09-27T16:40:00.000Z')

function owner(
	contactId: string,
	occurredAt = '2026-09-27T12:00:00.000Z',
	journeyId = 'value-path-skills-course',
): ContactEventRecord {
	return {
		id: `owner-${contactId}`,
		contactId,
		providerIdentityId: `identity-${contactId}`,
		provider: 'kit',
		providerEventId: `drovr-owner:${contactId}:${journeyId}`,
		providerReference: `kit:${contactId}`,
		eventType: 'journey.owner.assigned',
		occurredAt,
		semanticIdempotencyKey: `kit:journey.owner.assigned:1:drovr-owner:${contactId}:${journeyId}`,
		privacyLevel: 'internal',
		identityEvidence: {
			source: 'kit',
			strength: 'strong',
			providerIdentity: { provider: 'kit', externalId: '1' },
		},
		payloadSummary: {
			summary: 'Journey owner assigned',
			keywords: [],
			restrictedPayloadStored: false,
		},
		schemaVersion: 1,
		createdAt: occurredAt,
	}
}

const birthOf = (record: ContactEventRecord): DrovrShadowEvent =>
	mapDrovrShadowFact({ kind: 'contact-event', event: record })[0]!

const delivery = (
	status: 'delivered' | 'pending' | 'not-routed' | 'not-started',
): DrovrEmailDeliveryRead => ({
	ok: true,
	delivery: { status, route: null, deliveredAt: null, provider: null },
})

type World = {
	owners: ContactEventRecord[]
	stopped?: string[]
	birthOptOuts?: string[]
	reposted?: string[]
	delivery?: Record<string, DrovrEmailDeliveryRead>
	valuePathActor?: Record<string, DrovrActorRead>
	directoryActor?: Record<string, DrovrActorRead>
	post?: (event: DrovrShadowEvent) => Promise<unknown>
}

it('never re-posts a value-path birth skipped for recorded tag/state opt-out, while other journeys behave as before', async () => {
	const h = harness({
		owners: [
			owner('tagged'),
			owner('cancelled'),
			owner('active'),
			owner('evergreen', undefined, DROVR_EVERGREEN_OFFER_JOURNEY_ID),
		],
		birthOptOuts: ['tagged', 'cancelled', 'evergreen'],
	})
	const result = await h.run()
	expect(result).toMatchObject({ skippedStopped: 2, reposted: 2 })
	expect(h.posted.map((event) => event.contactId)).toEqual([
		'active',
		'evergreen',
	])
	expect(JSON.stringify(h.info.mock.calls)).not.toContain('@')
})

const NO_ACTOR: DrovrActorRead = { ok: true, found: false }

function harness(world: World) {
	const posted: DrovrShadowEvent[] = []
	const recorded: { ownerEventId: string; outcome: string }[] = []
	const info = vi.fn(async (_event: string, _fields: object) => undefined)
	const warn = vi.fn(async (_event: string, _fields: object) => undefined)
	const readDelivery = vi.fn(
		async (contactId: string) =>
			world.delivery?.[contactId] ?? delivery('not-started'),
	)
	const readActor = vi.fn(async (contactId: string, journeyId: string) =>
		journeyId === 'contact-directory'
			? (world.directoryActor?.[contactId] ?? {
					ok: true as const,
					found: true as const,
					stateName: 'provisional',
				})
			: (world.valuePathActor?.[contactId] ?? NO_ACTOR),
	)
	const scanOwners = vi.fn(
		async (args: {
			from: string
			to: string
			after?: { occurredAt: string; id: string }
			limit: number
		}) => {
			const sorted = [...world.owners].sort((a, b) =>
				a.occurredAt === b.occurredAt
					? a.id.localeCompare(b.id)
					: a.occurredAt.localeCompare(b.occurredAt),
			)
			const after = args.after
			return sorted
				.filter(
					(row) =>
						!after ||
						row.occurredAt > after.occurredAt ||
						(row.occurredAt === after.occurredAt && row.id > after.id),
				)
				.slice(0, args.limit)
		},
	)
	const ports: OwnerBirthGuardPorts = {
		scanOwners,
		stoppedContactIds: vi.fn(async () => new Set(world.stopped ?? [])),
		unsubscribedValuePathContactIds: vi.fn(
			async () => new Set(world.birthOptOuts ?? []),
		),
		repostedOwnerEventIds: vi.fn(
			async () =>
				new Set([
					...(world.reposted ?? []),
					...recorded.map((marker) => marker.ownerEventId),
				]),
		),
		readDelivery,
		readActor,
		post: vi.fn(async (event: DrovrShadowEvent) => {
			posted.push(event)
			const outcome = world.post
				? await world.post(event)
				: { status: 'accepted' }
			// A birth that lands: drovr answers delivered from then on.
			if ((outcome as { status: string }).status === 'accepted')
				world.delivery = {
					...world.delivery,
					[event.contactId]: delivery('delivered'),
				}
			return outcome as never
		}),
		recordRepost: vi.fn(async (record: ContactEventRecord, outcome) => {
			recorded.push({ ownerEventId: record.id, outcome })
		}),
		log: { info, warn },
	}
	// Inngest memoizes a finished step: a replay gets its output back.
	const memo = new Map<string, unknown>()
	const step = {
		run: vi.fn(async (id: string, operation: () => Promise<unknown>) => {
			if (!memo.has(id)) memo.set(id, await operation())
			return memo.get(id)
		}),
	}
	const run = (
		pageSize = 50,
		options: { maxPages?: number; fresh?: boolean } = {},
	) => {
		// A later run is a new Inngest run: nothing memoized carries over.
		if (options.fresh) memo.clear()
		return runOwnerBirthGuard({
			step: step as never,
			ports,
			startedAtMs: NOW,
			pageSize,
			...(options.maxPages === undefined ? {} : { maxPages: options.maxPages }),
		})
	}
	return {
		run,
		step,
		ports,
		posted,
		recorded,
		info,
		warn,
		scanOwners,
		readActor,
	}
}

const logged = (
	spy: { mock: { calls: [string, object][] } },
	message: string,
) => spy.mock.calls.filter(([name]) => name === message)

beforeEach(() => {
	vi.clearAllMocks()
})

describe('the owner-without-birth guard (row 110)', () => {
	it('lost confirmation step results still cannot perform physical target read 26', async () => {
		const h = harness({
			owners: Array.from({ length: 30 }, (_, i) => owner(`lost${i}`)),
		})
		let physical = 0
		h.ports.birthFeed = {
			reserveConfirmation: async () => {
				if (++physical > 25) throw new Error('confirmation cap exceeded')
			},
			observeBorn: vi.fn(async () => {}),
			judge: async (subjects) =>
				new Map(subjects.map((item) => [item, 'missing'])),
		}
		h.step.run.mockImplementation(async (id, operation) => {
			if (id.startsWith('feed-confirm-')) await operation() // simulate lost result
			return operation()
		})
		await expect(h.run()).rejects.toThrow('confirmation cap exceeded')
		expect(
			h.readActor.mock.calls.filter((call) => call[1] !== 'contact-directory'),
		).toHaveLength(25)
		expect(h.posted).toEqual([])
		expect(h.recorded).toEqual([])
	})

	it('an actor older than bootstrap is confirmed and cached, never reposted', async () => {
		const h = harness({
			owners: [owner('old-actor')],
			valuePathActor: {
				'old-actor': { ok: true, found: true, stateName: 'lessonTwelve' },
			},
		})
		const observed = new Set<string>()
		const observeBorn = vi.fn(async (_journey: string, id: string) => {
			observed.add(id)
		})
		h.ports.birthFeed = {
			reserveConfirmation: vi.fn(async () => {}),
			observeBorn,
			judge: async (subjects) =>
				new Map(
					subjects.map((item) => [
						item,
						observed.has(item.owner.contactId) ? 'born' : 'missing',
					]),
				),
		}
		expect(await h.run()).toMatchObject({
			born: 1,
			reposted: 0,
			birthConfirmations: 1,
		})
		expect(observeBorn).toHaveBeenCalledWith(
			'value-path-skills-course',
			'old-actor',
		)
		expect(h.readActor).toHaveBeenCalledTimes(1)
		expect(h.posted).toEqual([])
		expect(h.recorded).toEqual([])
		await h.run(50, { fresh: true })
		expect(h.readActor).toHaveBeenCalledTimes(1)
	})

	it('only 25 feed candidates across pages and journeys are confirmed; no read 26', async () => {
		const h = withNewsletter(
			harness({
				owners: Array.from({ length: 30 }, (_, i) =>
					owner(
						`c${String(i).padStart(2, '0')}`,
						undefined,
						i % 2
							? DROVR_EVERGREEN_OFFER_JOURNEY_ID
							: 'value-path-skills-course',
					),
				),
			}),
			['n1'],
		)
		const reserveConfirmation = vi.fn(async () => {})
		h.ports.birthFeed = {
			reserveConfirmation,
			observeBorn: vi.fn(async () => {}),
			judge: async (subjects) =>
				new Map(subjects.map((item) => [item, 'missing'])),
		}
		const result = await h.run(10)
		expect(result).toMatchObject({
			birthConfirmations: 25,
			reposted: 25,
			capHit: true,
		})
		expect(
			h.readActor.mock.calls.filter((call) => call[1] !== 'contact-directory'),
		).toHaveLength(25)
		expect(reserveConfirmation).toHaveBeenCalledTimes(25)
		await h.run(10)
		expect(reserveConfirmation).toHaveBeenCalledTimes(25)
	})

	it.each([429, 502, 503, 504, '5xx', 'timeout'] as const)(
		'a shed %s target confirmation defers all earlier candidates without posts/markers',
		async (status) => {
			const h = harness({
				owners: [owner('a'), owner('b')],
				valuePathActor: {
					b: {
						ok: false,
						reason: 'unknown',
						backpressure: { status, retryAfter: '7' },
					},
				},
			})
			h.ports.birthFeed = {
				reserveConfirmation: vi.fn(async () => {}),
				observeBorn: vi.fn(async () => {}),
				judge: async (subjects) =>
					new Map(subjects.map((item) => [item, 'missing'])),
			}
			expect(await h.run()).toMatchObject({
				status: 'deferred',
				reposted: 0,
				birthConfirmations: 2,
				backpressure: { status },
			})
			expect(h.posted).toEqual([])
			expect(h.recorded).toEqual([])
			expect(
				h.readActor.mock.calls.filter((call) => call[0] === 'b'),
			).toHaveLength(1)
		},
	)

	it('an unreadable target confirmation is never inferred absent or handed to directory', async () => {
		const h = harness({
			owners: [owner('unknown')],
			valuePathActor: { unknown: { ok: false, reason: 'bad shape' } },
		})
		h.ports.birthFeed = {
			reserveConfirmation: vi.fn(async () => {}),
			observeBorn: vi.fn(async () => {}),
			judge: async (subjects) =>
				new Map(subjects.map((item) => [item, 'missing'])),
		}
		expect(await h.run()).toMatchObject({
			unreadable: 1,
			reposted: 0,
			birthConfirmations: 1,
		})
		expect(h.readActor).toHaveBeenCalledOnce()
		expect(h.posted).toEqual([])
	})

	it('a durable confirmation reservation denied before HTTP prevents any repost', async () => {
		const h = harness({ owners: [owner('lost')] })
		h.ports.birthFeed = {
			reserveConfirmation: async () => {
				throw new Error('confirmation cap exceeded')
			},
			observeBorn: vi.fn(async () => {}),
			judge: async (subjects) =>
				new Map(subjects.map((item) => [item, 'missing'])),
		}
		await expect(h.run()).rejects.toThrow('confirmation cap exceeded')
		expect(h.readActor).not.toHaveBeenCalled()
		expect(h.posted).toEqual([])
	})

	it('feed presence skips per-contact birth/delivery reads; covered absence still checks directory, stops and opt-outs', async () => {
		const h = harness({
			owners: [
				owner('born'),
				owner('lost'),
				owner('stopped'),
				owner('unknown'),
				owner('tagged'),
				owner('suppressed'),
			],
			stopped: ['stopped'],
			birthOptOuts: ['tagged'],
			directoryActor: {
				suppressed: { ok: true, found: true, stateName: 'unsubscribed' },
			},
		})
		h.ports.birthFeed = {
			reserveConfirmation: vi.fn(async () => {}),
			observeBorn: vi.fn(async () => {}),
			judge: async (subjects) =>
				new Map(
					subjects.map((item) => [
						item,
						item.owner.contactId === 'born'
							? 'born'
							: item.owner.contactId === 'unknown'
								? 'unknown'
								: 'missing',
					]),
				),
		}
		const receipt = await h.run()
		expect(receipt).toMatchObject({
			born: 1,
			unreadable: 1,
			skippedStopped: 2,
			skippedSuppressed: 1,
			reposted: 1,
		})
		expect(h.posted.map((event) => event.contactId)).toEqual(['lost'])
		expect(h.ports.readDelivery).not.toHaveBeenCalled()
		expect(h.readActor).toHaveBeenCalledTimes(4)
		expect(
			h.readActor.mock.calls
				.filter((call) => call[1] !== 'contact-directory')
				.map((call) => call[0]),
		).toEqual(['lost', 'suppressed'])
	})

	it('a shed directory read in feed mode still suppresses all earlier candidates and markers', async () => {
		const h = harness({
			owners: [owner('a'), owner('b')],
			directoryActor: {
				b: { ok: false, reason: 'shed', backpressure: { status: 503 } },
			},
		})
		h.ports.birthFeed = {
			reserveConfirmation: vi.fn(async () => {}),
			observeBorn: vi.fn(async () => {}),
			judge: async (subjects) =>
				new Map(subjects.map((item) => [item, 'missing'])),
		}
		expect(await h.run()).toMatchObject({
			status: 'deferred',
			reposted: 0,
			candidates: 2,
			birthConfirmations: 2,
		})
		expect(h.posted).toEqual([])
		expect(h.recorded).toEqual([])
	})

	it('cache/membership failure does not switch to per-contact reads or enter reposting', async () => {
		const h = harness({ owners: [owner('lost')] })
		h.ports.birthFeed = {
			reserveConfirmation: vi.fn(async () => {}),
			observeBorn: vi.fn(async () => {}),
			judge: async () => {
				throw new Error('membership unavailable')
			},
		}
		await expect(h.run()).rejects.toThrow('membership unavailable')
		expect(h.readActor).not.toHaveBeenCalled()
		expect(h.ports.readDelivery).not.toHaveBeenCalled()
		expect(h.posted).toEqual([])
	})

	it('known repost markers consume no directory reads in feed mode', async () => {
		const h = harness({ owners: [owner('lost')], reposted: ['owner-lost'] })
		h.ports.birthFeed = {
			reserveConfirmation: vi.fn(async () => {}),
			observeBorn: vi.fn(async () => {}),
			judge: async (subjects) =>
				new Map(subjects.map((item) => [item, 'missing'])),
		}
		expect(await h.run()).toMatchObject({ repostNoEffect: 1, reposted: 0 })
		expect(h.readActor).not.toHaveBeenCalled()
	})

	it('memoizes a deferred page under the wall budget instead of retrying 50 slow subjects forever', async () => {
		const h = harness({
			owners: Array.from({ length: 50 }, (_, i) => owner(`slow${i}`)),
		})
		let clock = NOW
		h.ports.nowMs = () => clock
		const original = h.ports.readDelivery
		h.ports.readDelivery = vi.fn(async (id, timeoutMs) => {
			const result = await original(id, timeoutMs)
			clock += 10_000
			return result
		})
		const first = await h.run()
		expect(OWNER_BIRTH_GUARD_PAGE_BUDGET_MS).toBeLessThan(800_000)
		expect(clock - NOW).toBe(OWNER_BIRTH_GUARD_PAGE_BUDGET_MS)
		expect(first).toMatchObject({
			status: 'deferred',
			backpressure: { status: 'page-budget' },
			reposted: 0,
			truncated: true,
		})
		expect(h.ports.readDelivery).toHaveBeenCalledTimes(30)
		expect(h.posted).toEqual([])
		expect(h.recorded).toEqual([])
		expect(await h.run()).toEqual(first)
		expect(h.ports.readDelivery).toHaveBeenCalledTimes(30)
	})

	it('bounds the next read by the remaining page time and never starts the directory read after expiry', async () => {
		const h = harness({ owners: [owner('near-deadline')] })
		let clock = NOW
		h.ports.nowMs = () => clock
		const original = h.ports.readDelivery
		h.ports.readDelivery = async (id, timeoutMs) => {
			const result = await original(id, timeoutMs)
			clock += OWNER_BIRTH_GUARD_PAGE_BUDGET_MS - 1_500
			return result
		}
		h.ports.readActor = vi.fn(async (_id, _journey, timeoutMs) => {
			expect(timeoutMs).toBe(1_500)
			clock += 1_500
			return { ok: true as const, found: false as const }
		})
		expect(await h.run()).toMatchObject({
			status: 'deferred',
			backpressure: { status: 'page-budget' },
			reposted: 0,
		})
		expect(h.ports.readActor).toHaveBeenCalledOnce()
		expect(h.posted).toEqual([])
	})

	it.each([429, 502, 503, 504, 'timeout'] as const)(
		'stops the whole sweep on %s delivery shedding, with no reads/reposts after it',
		async (status) => {
			const h = harness({ owners: [owner('a'), owner('b')] })
			h.ports.readDelivery = vi.fn(async () => ({
				ok: false as const,
				reason: `drovr answered ${status}`,
				backpressure: { status, retryAfter: '10' },
			}))
			h.ports.scanNewsletterBirths = vi.fn(async () => ({ subjects: [] }))
			expect(await h.run()).toMatchObject({
				status: 'deferred',
				backpressure: { status, retryAfter: '10' },
				unreadable: 1,
				reposted: 0,
				truncated: true,
			})
			expect(h.ports.readDelivery).toHaveBeenCalledOnce()
			expect(h.readActor).not.toHaveBeenCalled()
			expect(h.ports.scanNewsletterBirths).not.toHaveBeenCalled()
			expect(h.posted).toEqual([])
			expect(h.recorded).toEqual([])
		},
	)

	it.each(['journey', 'directory'] as const)(
		'defers already-proven candidates when the later %s actor read is shed, without reposting or probing the next owner',
		async (where) => {
			const shed: DrovrActorRead = {
				ok: false,
				reason: 'drovr answered 503',
				backpressure: { status: 503, retryAfter: '5' },
			}
			const h = harness({
				owners: [owner('a'), owner('b'), owner('c')],
				...(where === 'journey'
					? { valuePathActor: { b: shed } }
					: { directoryActor: { b: shed } }),
			})
			expect(await h.run(1)).toMatchObject({
				status: 'deferred',
				candidates: 1,
				reposted: 0,
				truncated: true,
			})
			expect(h.ports.readDelivery).toHaveBeenCalledTimes(2)
			expect(h.readActor.mock.calls.some(([id]) => id === 'c')).toBe(false)
			expect(h.posted).toEqual([])
			expect(h.recorded).toEqual([])
		},
	)

	it('reads owners assigned between 72 h and 1 h ago', async () => {
		const h = harness({ owners: [] })
		await h.run()
		expect(h.scanOwners).toHaveBeenCalledWith(
			expect.objectContaining({
				from: '2026-09-24T16:40:00.000Z',
				to: '2026-09-27T15:40:00.000Z',
			}),
		)
	})

	it('re-posts the original birth key when drovr has no value-path actor', async () => {
		const lost = owner('lost1')
		const h = harness({ owners: [lost] })
		const receipt = await h.run()
		expect(h.posted).toEqual([birthOf(lost)])
		expect(h.posted[0]).toMatchObject({
			tenantId: 'org-aihero',
			journeyId: 'value-path-skills-course',
			type: 'contact.created',
			idempotencyKey: `aihero:${lost.semanticIdempotencyKey}`,
		})
		expect(h.recorded).toEqual([
			{ ownerEventId: 'owner-lost1', outcome: 'accepted' },
		])
		expect(logged(h.warn, 'drovr.owner_without_birth')).toHaveLength(1)
		expect(receipt).toMatchObject({
			candidates: 1,
			reposted: 1,
			capHit: false,
		})
	})

	it.each(['delivered', 'pending', 'not-routed'] as const)(
		'leaves a %s owner alone',
		async (status) => {
			const h = harness({
				owners: [owner('fine')],
				delivery: { fine: delivery(status) },
			})
			const receipt = await h.run()
			expect(h.posted).toEqual([])
			expect(h.readActor).not.toHaveBeenCalled()
			expect(receipt).toMatchObject({ candidates: 0, reposted: 0 })
		},
	)

	it('never re-posts when an actor exists but sent nothing: it logs that instead', async () => {
		const h = harness({
			owners: [owner('stuck')],
			valuePathActor: {
				stuck: { ok: true, found: true, stateName: 'email0.pending' },
			},
		})
		const receipt = await h.run()
		expect(h.posted).toEqual([])
		expect(
			logged(h.warn, 'drovr.owner_birth_guard.actor_without_send'),
		).toHaveLength(1)
		expect(receipt).toMatchObject({ actorWithoutSend: 1, candidates: 0 })
	})

	it('skips an owner with an ai-hero stop without reading drovr', async () => {
		const h = harness({ owners: [owner('gone')], stopped: ['gone'] })
		const receipt = await h.run()
		expect(h.posted).toEqual([])
		expect(h.ports.readDelivery).not.toHaveBeenCalled()
		expect(receipt).toMatchObject({ skippedStopped: 1, candidates: 0 })
	})

	it('skips an owner whose drovr directory actor is stopped', async () => {
		const h = harness({
			owners: [owner('unsub')],
			directoryActor: {
				unsub: { ok: true, found: true, stateName: 'unsubscribed' },
			},
		})
		const receipt = await h.run()
		expect(h.posted).toEqual([])
		expect(receipt).toMatchObject({ skippedSuppressed: 1, candidates: 0 })
	})

	it('skips a synthetic principal without reading drovr', async () => {
		const h = harness({ owners: [owner('synthetic_run-1')] })
		const receipt = await h.run()
		expect(h.posted).toEqual([])
		expect(h.ports.readDelivery).not.toHaveBeenCalled()
		expect(receipt).toMatchObject({ skippedSynthetic: 1 })
	})

	it('re-posts a key at most once ever: a repeat sighting is logged, not posted', async () => {
		const h = harness({ owners: [owner('again')], reposted: ['owner-again'] })
		const receipt = await h.run()
		expect(h.posted).toEqual([])
		expect(
			logged(h.warn, 'drovr.owner_birth_guard.repost_no_effect'),
		).toHaveLength(1)
		expect(receipt).toMatchObject({ repostNoEffect: 1, candidates: 0 })
	})

	it.each([
		['the delivery read', { delivery: { x: { ok: false, reason: '500' } } }],
		['the actor read', { valuePathActor: { x: { ok: false, reason: '500' } } }],
		[
			'the directory read',
			{ directoryActor: { x: { ok: false, reason: '500' } } },
		],
	] as const)('never re-posts when %s is unreadable', async (_name, world) => {
		const h = harness({ owners: [owner('x')], ...(world as Partial<World>) })
		const receipt = await h.run()
		expect(h.posted).toEqual([])
		expect(receipt).toMatchObject({ unreadable: 1, candidates: 0 })
	})

	it('counts a re-post drovr refuses as suppressed, records it, and never retries it', async () => {
		const h = harness({
			owners: [owner('sup')],
			post: async () => ({
				status: 'rejected',
				httpStatus: 409,
				problem: { type: 'urn:drovr:problem:contact-suppressed' },
			}),
		})
		const receipt = await h.run()
		expect(h.posted).toHaveLength(1)
		expect(h.recorded).toEqual([
			{ ownerEventId: 'owner-sup', outcome: 'suppressed' },
		])
		expect(receipt).toMatchObject({ reposted: 0, suppressedOnPost: 1 })
	})

	it.each([
		['its type', { type: 'urn:drovr:problem:contact-suppressed' }],
		['its code', { code: 'contact-suppressed' }],
		['a detail string', JSON.stringify({ code: 'contact-suppressed' })],
	])('reads suppressed from %s only', async (_name, problem) => {
		const h = harness({
			owners: [owner('sup')],
			post: async () => ({ status: 'rejected', httpStatus: 409, problem }),
		})
		await h.run()
		expect(h.recorded).toEqual([
			{ ownerEventId: 'owner-sup', outcome: 'suppressed' },
		])
	})

	it("never reads suppressed from a problem's served text (201g-f2: a wording change must not flip the label)", async () => {
		const h = harness({
			owners: [owner('x')],
			post: async () => ({
				status: 'rejected',
				httpStatus: 409,
				problem: {
					type: 'urn:drovr:problem:idempotency-key-holds-another-event',
					title: 'Suppressed? No: the key holds another event',
					detail: 'This contact may be suppressed elsewhere.',
					hint: 'Check the suppression list, then use a new key.',
				},
			}),
		})
		const receipt = await h.run()
		expect(h.recorded).toEqual([
			{ ownerEventId: 'owner-x', outcome: 'rejected' },
		])
		expect(receipt).toMatchObject({ suppressedOnPost: 0 })
	})

	it(`re-posts at most ${OWNER_BIRTH_GUARD_REPOST_CAP} a run and says the cap was hit`, async () => {
		const owners = Array.from(
			{ length: OWNER_BIRTH_GUARD_REPOST_CAP + 5 },
			(_, i) => owner(`c${String(i).padStart(2, '0')}`),
		)
		const h = harness({ owners })
		const receipt = await h.run(10)
		expect(h.posted).toHaveLength(OWNER_BIRTH_GUARD_REPOST_CAP)
		expect(receipt).toMatchObject({
			candidates: OWNER_BIRTH_GUARD_REPOST_CAP + 5,
			reposted: OWNER_BIRTH_GUARD_REPOST_CAP,
			capHit: true,
			overCap: 5,
		})
		expect(logged(h.warn, 'drovr.owner_birth_guard.cap_hit')).toHaveLength(1)
	})

	it('posts what the cap left on the next run, oldest first, so none ages out', async () => {
		const owners = Array.from(
			{ length: OWNER_BIRTH_GUARD_REPOST_CAP + 5 },
			(_, i) => owner(`c${String(i).padStart(2, '0')}`),
		)
		const h = harness({ owners })
		await h.run(10)
		expect(h.posted.map((event) => event.contactId)).toEqual(
			owners.slice(0, OWNER_BIRTH_GUARD_REPOST_CAP).map((o) => o.contactId),
		)
		const next = await h.run(10, { fresh: true })
		expect(
			h.posted
				.slice(OWNER_BIRTH_GUARD_REPOST_CAP)
				.map((event) => event.contactId),
		).toEqual(
			owners.slice(OWNER_BIRTH_GUARD_REPOST_CAP).map((o) => o.contactId),
		)
		expect(next).toMatchObject({
			reposted: 5,
			capHit: false,
			repostNoEffect: 0,
		})
	})

	it('says so, loudly, when a run stops at its page limit', async () => {
		const owners = Array.from({ length: 5 }, (_, i) => owner(`t${i}`))
		const h = harness({
			owners,
			delivery: Object.fromEntries(
				owners.map((o) => [o.contactId, delivery('delivered')]),
			),
		})
		const receipt = await h.run(2, { maxPages: 2 })
		expect(receipt).toMatchObject({ owners: 4, truncated: true })
		expect(logged(h.warn, 'drovr.owner_birth_guard.truncated')).toHaveLength(1)
	})

	it('pages through every owner in the window', async () => {
		const owners = Array.from({ length: 7 }, (_, i) => owner(`p${i}`))
		const h = harness({
			owners,
			delivery: Object.fromEntries(
				owners.map((o) => [o.contactId, delivery('delivered')]),
			),
		})
		const receipt = await h.run(3)
		expect(h.scanOwners).toHaveBeenCalledTimes(3)
		expect(receipt).toMatchObject({ owners: 7, delivered: 7 })
	})

	it('fails the run, never re-posting, when the stop read fails', async () => {
		const h = harness({ owners: [owner('lost2')] })
		h.ports.stoppedContactIds = vi.fn(async () => {
			throw new Error('Vitess: connection reset')
		})
		await expect(h.run()).rejects.toThrow('connection reset')
		expect(h.posted).toEqual([])
	})

	it('logs and posts once however often Inngest replays the run', async () => {
		const h = harness({ owners: [owner('lost3')] })
		const first = await h.run()
		const replay = await h.run()
		expect(replay).toEqual(first)
		expect(h.posted).toHaveLength(1)
		expect(logged(h.warn, 'drovr.owner_without_birth')).toHaveLength(1)
		expect(logged(h.info, 'drovr.owner_birth_guard.summary')).toHaveLength(1)
	})
})

describe('the re-post marker', () => {
	it('is keyed by the owner event, maps to no drovr event, and records the outcome', async () => {
		const { ownerBirthRepostMarker, OWNER_BIRTH_REPOSTED_EVENT_TYPE } =
			await import('./owner-birth-guard-drizzle')
		const record = owner('m1')
		const marker = ownerBirthRepostMarker(
			record,
			'suppressed',
			'2026-09-27T16:40:00.000Z',
		)
		expect(marker).toMatchObject({
			contactId: 'm1',
			providerIdentityId: 'identity-m1',
			eventType: OWNER_BIRTH_REPOSTED_EVENT_TYPE,
			providerEventId: 'drovr-owner-birth-repost:owner-m1',
			semanticIdempotencyKey: 'drovr-owner-birth-repost:owner-m1',
			occurredAt: '2026-09-27T16:40:00.000Z',
			payloadSummary: expect.objectContaining({ keywords: ['suppressed'] }),
		})
		expect(
			mapDrovrShadowFact({
				kind: 'contact-event',
				event: { ...marker, id: 'x', createdAt: marker.occurredAt },
			}),
		).toEqual([])
	})
})

describe('row 204: the guard covers evergreen and newsletter births', () => {
	const evergreenOwner = (contactId: string) =>
		owner(
			contactId,
			'2026-09-27T12:00:00.000Z',
			DROVR_EVERGREEN_OFFER_JOURNEY_ID,
		)
	const newsletterOwner = (contactId: string) =>
		owner(
			contactId,
			'2026-09-20T12:00:00.000Z',
			DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		)
	const newsletterBirth = (contactId: string): DrovrShadowEvent => ({
		tenantId: 'org-aihero',
		contactId,
		journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
		type: 'contact.created',
		occurredAt: '2026-09-27T12:00:00.000Z',
		idempotencyKey: `owner:contact:org-aihero-shadow:${contactId}:shadow-newsletter:birth`,
		payload: {
			timezone: 'Asia/Tokyo',
			timezoneSource: 'vercel-header',
		} as never,
	})
	const withNewsletter = (
		h: ReturnType<typeof harness>,
		contactIds: string[],
	) => {
		h.ports.scanNewsletterBirths = vi.fn(async () => ({
			subjects: contactIds.map((contactId) => ({
				owner: newsletterOwner(contactId),
				journeyId: DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
				birth: newsletterBirth(contactId),
			})),
		}))
		return h
	}

	it("re-posts a lost evergreen birth once, exactly as the owner's dispatch built it", async () => {
		const lost = evergreenOwner('e1')
		const h = harness({ owners: [lost] })
		const receipt = await h.run()
		expect(h.posted).toEqual([birthOf(lost)])
		expect(h.posted[0]).toMatchObject({
			tenantId: 'org-aihero',
			journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
			type: 'contact.created',
		})
		expect(receipt).toMatchObject({
			reposted: 1,
			candidatesByJourney: { [DROVR_EVERGREEN_OFFER_JOURNEY_ID]: 1 },
		})
		// Judged by its actor alone: no lesson-one read for evergreen.
		expect(h.ports.readDelivery).not.toHaveBeenCalled()
		expect(h.readActor).toHaveBeenCalledWith(
			'e1',
			DROVR_EVERGREEN_OFFER_JOURNEY_ID,
			10_000,
		)
		// Never twice.
		await h.run(50, { fresh: true })
		expect(h.posted).toHaveLength(1)
	})

	it('leaves an evergreen birth whose actor exists', async () => {
		const h = harness({
			owners: [evergreenOwner('e1')],
			valuePathActor: {
				e1: { ok: true, found: true, stateName: 'pitchOne' },
			},
		})
		const receipt = await h.run()
		expect(h.posted).toEqual([])
		expect(receipt).toMatchObject({ born: 1, candidates: 0 })
	})

	it('does not re-post an evergreen birth for a contact drovr has stopped', async () => {
		const h = harness({
			owners: [evergreenOwner('e1')],
			directoryActor: {
				e1: { ok: true, found: true, stateName: 'unsubscribed' },
			},
		})
		expect((await h.run()).skippedSuppressed).toBe(1)
		expect(h.posted).toEqual([])
	})

	it('re-posts a lost newsletter birth once, rebuilt from its intent', async () => {
		const h = withNewsletter(harness({ owners: [] }), ['n1'])
		const receipt = await h.run()
		expect(h.posted).toEqual([newsletterBirth('n1')])
		expect(h.recorded).toEqual([
			{ ownerEventId: newsletterOwner('n1').id, outcome: 'accepted' },
		])
		expect(receipt.candidatesByJourney).toEqual({
			[DROVR_SHADOW_NEWSLETTER_JOURNEY_ID]: 1,
		})
		expect(h.readActor).toHaveBeenCalledWith(
			'n1',
			DROVR_SHADOW_NEWSLETTER_JOURNEY_ID,
			10_000,
		)
		await h.run(50, { fresh: true })
		expect(h.posted).toHaveLength(1)
	})

	it('leaves a newsletter birth whose actor exists', async () => {
		const h = withNewsletter(
			harness({
				owners: [],
				valuePathActor: {
					n1: { ok: true, found: true, stateName: 'subscribed' },
				},
			}),
			['n1'],
		)
		expect(await h.run()).toMatchObject({ born: 1, candidates: 0 })
		expect(h.posted).toEqual([])
	})

	it('logs candidates against the cap on every run, capHit or not (the hawk, 09-30)', async () => {
		const quiet = harness({ owners: [] })
		await quiet.run()
		const calm = (
			logged(quiet.info as never, 'drovr.owner_birth_guard.summary') as [
				string,
				Record<string, unknown>,
			][]
		)[0]![1]
		expect(calm).toMatchObject({ candidates: 0, capHit: false, overCap: 0 })

		const busy = withNewsletter(
			harness({
				owners: Array.from({ length: OWNER_BIRTH_GUARD_REPOST_CAP }, (_, i) =>
					evergreenOwner(`e${i}`),
				),
			}),
			['n1', 'n2'],
		)
		const receipt = await busy.run()
		expect(receipt).toMatchObject({
			candidates: OWNER_BIRTH_GUARD_REPOST_CAP + 2,
			capHit: true,
			overCap: 2,
			candidatesByJourney: {
				[DROVR_EVERGREEN_OFFER_JOURNEY_ID]: OWNER_BIRTH_GUARD_REPOST_CAP,
				[DROVR_SHADOW_NEWSLETTER_JOURNEY_ID]: 2,
			},
		})
		expect(busy.posted).toHaveLength(OWNER_BIRTH_GUARD_REPOST_CAP)
		const summary = (
			logged(busy.info as never, 'drovr.owner_birth_guard.summary') as [
				string,
				Record<string, unknown>,
			][]
		)[0]![1]
		expect(summary).toMatchObject({
			candidates: OWNER_BIRTH_GUARD_REPOST_CAP + 2,
			capHit: true,
		})
		expect(
			logged(busy.warn as never, 'drovr.owner_birth_guard.cap_hit'),
		).toEqual([
			[
				'drovr.owner_birth_guard.cap_hit',
				expect.objectContaining({
					overCap: 2,
					candidatesByJourney: expect.any(Object),
				}),
			],
		])
	})
})
