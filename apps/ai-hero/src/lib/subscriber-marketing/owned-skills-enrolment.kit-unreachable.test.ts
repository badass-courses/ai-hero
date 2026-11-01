import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	dispatch: vi.fn(),
	kit: vi.fn(() => {
		throw new Error('Kit unreachable')
	}),
}))
vi.mock('./drovr-shadow-dispatch', () => ({
	dispatchDrovrShadowFactSafely: mocks.dispatch,
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {
		subscribeToList: mocks.kit,
		getSubscriberByEmail: mocks.kit,
	},
}))
vi.mock('@/server/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }))

import { InMemorySubscriberMarketingRepository } from './dry-run'
import { deadlineTimeZoneEvidenceFromHeader } from './course-sequence-exhaustion'
import { normalizeContactEvent } from './normalize-contact-event'
import {
	enterOwnedSkillsSubscriber,
	hasConfirmedSkillsConsent,
} from './owned-skills-enrolment'
import { progressValuePathDrips } from './value-path-drip-progression'
import {
	mapDrovrShadowFact,
	DROVR_AUTHORITY_TENANT_ID,
} from './drovr-shadow-emitter'
import type { GateDRuntimeAllowlist } from './value-path-gate-d-allowlist'
import type { SideEffectIntent } from './types'

const now = '2026-11-01T05:00:00.000Z'
const ownership = { percent: 100, emails: new Set<string>() }
const allowlist: GateDRuntimeAllowlist = {
	activationId: 'owned-enrolment-test',
	status: 'active',
	killSwitch: false,
	mode: 'scoped-live',
	authorizationMode: 'rolling-public-enrollment',
	pathSlugs: ['ai-hero-skills-workflow'],
	contactIds: [],
	kitSubscriberIds: [],
	emails: [],
	emailHashes: [],
	emailResourceIds: ['ai-hero-skills-workflow.email-0'],
	kitSequenceIds: ['2757199'],
	candidates: [],
	allowedActions: ['send-path-emails'],
	createdAt: now,
}
function setup() {
	const repository = new InMemorySubscriberMarketingRepository()
	const row = repository.createContact({
		email: 'learner@example.test',
		name: 'Learner',
		lifecycle: 'new',
		isProvisional: false,
		userId: null,
		createdAt: now,
		updatedAt: now,
	})
	const input = {
		contactId: row.id,
		email: row.email!,
		formId: 9376133,
		source: 'aihero_skills_page',
		subscribedAt: now,
	}
	const requestProfileSync = vi.fn().mockResolvedValue(undefined)
	return { repository, row, input, requestProfileSync }
}

describe('owned Skills enrolment with Kit unreachable', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('a new course learner gets an owned capture, owner birth and access, without Kit or a shadow newsletter', async () => {
		const args = setup()
		expect(
			await enterOwnedSkillsSubscriber({ ...args, ownership }),
		).toMatchObject({ status: 'drovr-owned', contactId: args.row.id })
		const events = [...args.repository.contactEvents.values()]
		const owner = events.find(
			(event) => event.eventType === 'journey.owner.assigned',
		)!
		const access = events.find(
			(event) => event.eventType === 'value-path.entered',
		)!
		expect(owner.provider).toBe('ai-hero')
		expect(events.indexOf(owner)).toBeLessThan(events.indexOf(access))
		expect(
			events.find(
				(event) => event.eventType === 'skills-newsletter.subscribed',
			),
		).toMatchObject({ provider: 'ai-hero', contactId: args.row.id })
		expect(access.providerReference).toBe('value-path:ai-hero-skills-workflow')
		expect(
			events.some((event) => event.eventType.startsWith('newsletter.')),
		).toBe(false)
		expect(
			[...args.repository.sideEffectIntents.values()].every(
				(intent) => intent.provider === 'dry-run',
			),
		).toBe(true)
		const birth = mapDrovrShadowFact({
			kind: 'contact-event',
			event: owner,
		}).find((event) => event.tenantId === DROVR_AUTHORITY_TENANT_ID)
		expect(birth).toMatchObject({
			contactId: args.row.id,
			type: 'contact.created',
		})
		expect(args.requestProfileSync).toHaveBeenCalledWith(
			expect.objectContaining({
				contactId: args.row.id,
				reason: 'journey-entered',
			}),
		)
		expect(mocks.kit).not.toHaveBeenCalled()
	})

	it('keeps course-entry timezone evidence in the owned evidence store without a Kit stash', async () => {
		const args = setup()
		const zone = deadlineTimeZoneEvidenceFromHeader({
			headerValue: 'Europe/London',
			capturedAt: now,
		})
		if (!zone.ok) throw new Error('invalid test zone')
		await enterOwnedSkillsSubscriber({
			...args,
			input: { ...args.input, deadlineTimeZone: zone.value },
			ownership,
		})
		const access = [...args.repository.contactEvents.values()].find(
			(event) => event.eventType === 'value-path.entered',
		)
		expect(access?.domainPayload).toMatchObject({
			deadlineTimeZone: zone.value,
			valuePathId: 'ai-hero-skills-workflow',
			emailResourceId: 'ai-hero-skills-workflow.email-0',
		})
		expect(mocks.kit).not.toHaveBeenCalled()
	})

	it('a returning learner keeps one access fact and one owner; the legacy drip defers to drovr', async () => {
		const args = setup()
		await enterOwnedSkillsSubscriber({ ...args, ownership })
		await enterOwnedSkillsSubscriber({
			...args,
			ownership: { percent: 0, emails: new Set<string>() },
		})
		const events = [...args.repository.contactEvents.values()]
		expect(
			events.filter((event) => event.eventType === 'journey.owner.assigned'),
		).toHaveLength(1)
		expect(
			events.filter((event) => event.eventType === 'value-path.entered'),
		).toHaveLength(1)
		const completed: SideEffectIntent = {
			id: 'completed-email-0',
			nextActionId: 'action-0',
			contactId: args.row.id,
			provider: 'kit',
			type: 'send-value-path-email',
			status: 'completed',
			idempotencyKey: 'test-email-0',
			gates: [],
			reviewReasons: [],
			createdAt: now,
			completedAt: now,
			metadata: {
				emailResourceId: 'ai-hero-skills-workflow.email-0',
				completedAt: now,
			},
		}
		const drip = await progressValuePathDrips({
			repository: args.repository,
			allowlist,
			completedIntents: [completed],
			allowWrite: true,
			now: '2026-11-03T18:00:00.000Z',
		})
		expect(drip.results[0]).toMatchObject({
			status: 'deferred',
			reviewReasons: ['drovr-owned'],
		})
		expect(
			[...args.repository.sideEffectIntents.values()].every(
				(intent) => intent.provider === 'dry-run',
			),
		).toBe(true)
		expect(mocks.kit).not.toHaveBeenCalled()
	})

	it('an unsubscribe arriving after enqueue prevents ownership and access without lifting the stop', async () => {
		const args = setup()
		args.repository.createContactEvent({
			...normalizeContactEvent({
				provider: 'ai-hero',
				externalId: args.row.id,
				providerEventId: 'stop-1',
				eventType: 'contact.unsubscribed',
				occurredAt: now,
				email: args.row.email!,
				message: 'Unsubscribed',
				privacyLevel: 'internal',
			}),
			contactId: args.row.id,
			providerIdentityId: 'synthetic-stop-identity',
			createdAt: now,
		})
		expect(
			await enterOwnedSkillsSubscriber({ ...args, ownership }),
		).toMatchObject({ status: 'blocked', reason: 'contact-stopped' })
		expect(
			[...args.repository.contactEvents.values()].map(
				(event) => event.eventType,
			),
		).toEqual(['contact.unsubscribed'])
		expect(mocks.kit).not.toHaveBeenCalled()
	})

	it('a directory miss or mismatched address refuses cleanly, never looking up Kit', async () => {
		const args = setup()
		await expect(
			enterOwnedSkillsSubscriber({
				...args,
				input: { ...args.input, contactId: 'missing' },
				ownership,
			}),
		).rejects.toThrow('contact mismatch')
		await expect(
			enterOwnedSkillsSubscriber({
				...args,
				input: { ...args.input, email: 'other@example.test' },
				ownership,
			}),
		).rejects.toThrow('contact mismatch')
		expect(args.repository.contactEvents.size).toBe(0)
		expect(mocks.kit).not.toHaveBeenCalled()
	})

	it('never invents a legacy fallback when the owner rollout is off', async () => {
		const args = setup()
		expect(
			await enterOwnedSkillsSubscriber({
				...args,
				ownership: { percent: 0, emails: new Set<string>() },
			}),
		).toMatchObject({ status: 'blocked', reason: 'legacy-owner' })
		expect(
			[...args.repository.contactEvents.values()].some(
				(event) => event.eventType === 'value-path.entered',
			),
		).toBe(false)
		expect(
			[...args.repository.sideEffectIntents.values()].every(
				(intent) => intent.provider === 'dry-run',
			),
		).toBe(true)
	})

	it('requires the Skills form, not a confirmed profile or another confirmed form', () => {
		expect(
			hasConfirmedSkillsConsent({
				state: 'confirmed',
				forms: [{ formId: 'other', state: 'confirmed' }],
				stops: [],
			}),
		).toBe(false)
	})
})
