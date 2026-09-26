import { describe, expect, it } from 'vitest'

import { captureNormalizedContactEvent } from './capture-contact-event'
import { createMemoryContactProfileVersionStore } from './contact-profile-version'
import { runContactSyncReconcile } from './contact-sync-reconcile'
import { InMemorySubscriberMarketingRepository } from './dry-run'
import {
	kitIdentityOf,
	readContactProfileSnapshot,
	runContactProfileSync,
} from './drovr-contact-profile-sync'
import type {
	DrovrContactProfilePayload,
	DrovrShadowEvent,
} from './drovr-shadow-emitter'
import { normalizeContactEvent } from './normalize-contact-event'
import { createMemoryValuePathLinkAnchorStore } from './value-path-link-anchor'

/**
 * The hawk's condition for PR 3: a hold input that changes without a
 * scanned ContactEvent would be lost under a true-looking watermark. Each
 * case changes one hold's input the way production does and asserts the
 * next reconcile pushes a newer profileVersion that carries it.
 */
function world() {
	const repository = new InMemorySubscriberMarketingRepository()
	const versions = createMemoryContactProfileVersionStore()
	const linkAnchors = createMemoryValuePathLinkAnchorStore()
	const delivered: DrovrShadowEvent[] = []
	let clock = new Date('2026-09-26T18:00:00.000Z')
	let watermark: string | undefined

	const kitIdentity = (contactId: string) =>
		kitIdentityOf(
			[...repository.providerIdentities.values()]
				.filter(
					(identity) =>
						identity.contactId === contactId && identity.provider === 'kit',
				)
				.map((identity) => identity.externalId),
		)

	const sync = (contactId: string) =>
		runContactProfileSync({
			event: { data: { contactId, reason: 'reconcile' } },
			step: { run: (_id, callback) => callback() },
			env: { AIH_DROVR_PROFILE_SYNC: 'true' },
			readSnapshot: ({ contactId: id, valuePathSlug }) =>
				readContactProfileSnapshot({
					repository,
					contactId: id,
					kitIdentity: kitIdentity(id),
					valuePathSlug,
					answerPages: [],
					baseUrl: 'https://www.aihero.dev',
					pathTokenSecret: 'test-secret',
					linkAnchors,
					now: clock.toISOString(),
				}),
			bump: (id) => versions.bump(id),
			deliver: async (events) => {
				delivered.push(...events)
				return { accepted: events.length, rejected: 0 }
			},
			ownedPath: async () => undefined,
		})

	const reconcile = () =>
		runContactSyncReconcile({
			now: () => clock,
			readWatermark: async () => watermark,
			scanChanges: async ({ after, through, limit }) =>
				[...repository.contactEvents.values()]
					.filter(
						(event) =>
							Date.parse(event.occurredAt) > Date.parse(after) &&
							Date.parse(event.occurredAt) <= Date.parse(through),
					)
					.sort(
						(left, right) =>
							Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
							left.id.localeCompare(right.id),
					)
					.slice(0, limit + 1)
					.map((event) => ({
						id: event.id,
						contactId: event.contactId,
						eventType: event.eventType,
						occurredAt: event.occurredAt,
					})),
			rotatedContacts: async () => [],
			syncContact: async (contactId) =>
				(await sync(contactId)).status === 'sent' ? 'sent' : 'skipped',
			resendStops: async () => undefined,
			heartbeat: async () => undefined,
			writeWatermark: async (next) => {
				watermark = next
			},
		})

	const capture = (args: {
		id: string
		occurredAt: string
		message: string
		email?: string
		kitSubscriberId?: string
	}) =>
		captureNormalizedContactEvent({
			repository,
			event: normalizeContactEvent({
				provider: 'kit',
				providerEventId: args.id,
				eventType: 'kit.message',
				occurredAt: args.occurredAt,
				email: args.email,
				externalId: args.kitSubscriberId ?? 'kit-1',
				message: args.message,
			}),
		})

	const profile = (contactId: string) => {
		const latest = delivered
			.filter(
				(event) =>
					event.contactId === contactId &&
					event.type === 'contact.profile.updated',
			)
			.at(-1)
		return latest?.payload as DrovrContactProfilePayload | undefined
	}

	return {
		repository,
		capture,
		reconcile,
		sync,
		profile,
		advance: (minutes: number) => {
			clock = new Date(clock.getTime() + minutes * 60_000)
		},
	}
}

const learner = 'learner@example.test'

async function baseline(w: ReturnType<typeof world>) {
	const captured = await w.capture({
		id: 'signup',
		occurredAt: '2026-09-26T17:30:00.000Z',
		email: learner,
		message: 'Signed up for the skills newsletter',
	})
	await w.reconcile()
	const first = w.profile(captured.contact.id)
	expect(first?.profileVersion).toBe(1)
	return { contactId: captured.contact.id, first: first! }
}

describe('contact sync: every hold change reaches drovr on the next reconcile', () => {
	it('support-intent: a captured message asking for help', async () => {
		const w = world()
		const { contactId, first } = await baseline(w)
		expect(first.holds).not.toContain('support-intent')
		await w.capture({
			id: 'reply',
			occurredAt: '2026-09-26T18:05:00.000Z',
			email: learner,
			message: 'I need help, my login is broken',
		})
		w.advance(15)
		await w.reconcile()
		expect(w.profile(contactId)).toMatchObject({
			profileVersion: 2,
			holds: expect.arrayContaining(['support-intent']),
		})
	})

	it('team-sales-intent: a captured message about a team license', async () => {
		const w = world()
		const { contactId, first } = await baseline(w)
		expect(first.holds).not.toContain('team-sales-intent')
		await w.capture({
			id: 'reply',
			occurredAt: '2026-09-26T18:05:00.000Z',
			email: learner,
			message: 'Can we buy a team license for 12 seats?',
		})
		w.advance(15)
		await w.reconcile()
		expect(w.profile(contactId)).toMatchObject({
			profileVersion: 2,
			holds: expect.arrayContaining(['team-sales-intent']),
		})
	})

	it('identity-conflict: a second Kit identity arriving with a captured event', async () => {
		const w = world()
		const { contactId, first } = await baseline(w)
		expect(first.holds).not.toContain('identity-conflict')
		await w.repository.createProviderIdentity({
			contactId,
			provider: 'kit',
			externalId: 'kit-2',
			evidence: {},
			createdAt: '2026-09-26T18:04:00.000Z',
			updatedAt: '2026-09-26T18:04:00.000Z',
		} as never)
		await w.capture({
			id: 'second-kit',
			occurredAt: '2026-09-26T18:05:00.000Z',
			email: learner,
			kitSubscriberId: 'kit-2',
			message: 'Subscribed again',
		})
		w.advance(15)
		await w.reconcile()
		expect(w.profile(contactId)).toMatchObject({
			profileVersion: 2,
			holds: expect.arrayContaining(['identity-conflict']),
		})
	})

	it('stale-state: a contact born without state gains one from a captured event', async () => {
		const w = world()
		// Born the way the Kit directory ingest births contacts: no state.
		const born = await w.repository.createContactAndProviderIdentity(
			{
				userId: null,
				email: learner,
				name: null,
				lifecycle: 'new',
				isProvisional: true,
				optInAttribution: null,
				createdAt: '2026-09-26T17:00:00.000Z',
				updatedAt: '2026-09-26T17:00:00.000Z',
			} as never,
			{
				provider: 'kit',
				externalId: 'kit-1',
				evidence: {},
				createdAt: '2026-09-26T17:00:00.000Z',
				updatedAt: '2026-09-26T17:00:00.000Z',
			} as never,
		)
		const contactId = born.contact.id
		await w.sync(contactId)
		expect(w.profile(contactId)?.holds).toContain('stale-state')
		await w.capture({
			id: 'first-event',
			occurredAt: '2026-09-26T18:05:00.000Z',
			email: learner,
			message: 'Signed up for the skills newsletter',
		})
		w.advance(15)
		await w.reconcile()
		expect(w.profile(contactId)?.profileVersion).toBe(2)
		expect(w.profile(contactId)?.holds).not.toContain('stale-state')
	})

	it('contact-email-missing: set when the contact is captured without an address (creation is its only writer)', async () => {
		const w = world()
		const captured = await w.capture({
			id: 'no-email',
			occurredAt: '2026-09-26T17:30:00.000Z',
			message: 'Signed up for the skills newsletter',
		})
		await w.reconcile()
		expect(w.profile(captured.contact.id)).toMatchObject({
			profileVersion: 1,
			email: '',
			holds: expect.arrayContaining(['contact-email-missing']),
		})
	})

	it('re-pushes a change while it sits inside the 1 h overlap, then settles', async () => {
		const w = world()
		const { contactId } = await baseline(w) // event 17:30, pushed at 18:00 as v1
		for (let run = 0; run < 8; run += 1) {
			w.advance(15)
			await w.reconcile()
		}
		// The overlap trails the latest watermark by an hour, so the 17:30
		// event is re-pushed by the 18:15, 18:30 and 18:45 runs, then never
		// again: the price of catching late-written events without a
		// createdAt index. Link events keep their keys and dedupe at drovr;
		// only the small profile event repeats.
		expect(w.profile(contactId)?.profileVersion).toBe(4)
	})
})
