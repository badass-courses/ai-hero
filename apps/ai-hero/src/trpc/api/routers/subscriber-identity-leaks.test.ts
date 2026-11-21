import { createMongoAbility } from '@casl/ability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	eligibility: vi.fn(),
	gating: vi.fn(),
	fullRecord: vi.fn(),
	linkSubscriber: vi.fn(),
}))
vi.mock('@/db', () => ({ courseBuilderAdapter: {}, db: {} }))
vi.mock('@/lib/certificates', () => ({
	checkCohortCertificateEligibility: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificates', () => ({
	checkSkillsWorkflowValuePathCertificateEligibility: mocks.eligibility,
}))
vi.mock('@/lib/survey-link-identity', () => ({
	readVerifiedLinkSubscriber: mocks.linkSubscriber,
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: mocks.session }))
vi.mock('@/server/logger', () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@/utils/cloudinary', () => ({ cloudinary: {} }))
vi.mock('@coursebuilder/core/certificates', () => ({
	getCertificatePublicId: vi.fn(),
}))
vi.mock('@/lib/convertkit', () => ({
	getSubscriberFromCookie: mocks.fullRecord,
}))
vi.mock('@/lib/lists-query', () => ({ getAllLists: vi.fn() }))
vi.mock('@/lib/posts-query', () => ({ getAllPosts: vi.fn() }))
vi.mock('@/lib/skills-cta-state', () => ({ resolveSkillsCtaState: vi.fn() }))
vi.mock('@/lib/entitlements-query', () => ({
	hasEntitlementForResource: vi.fn(),
}))
vi.mock('@/lib/subscriber-gate', () => ({ getCtaGatingPayload: mocks.gating }))
vi.mock('@/utils/get-current-ability-rules', () => ({
	getCurrentAbilityRules: vi.fn(),
}))

import { abilityRouter } from './ability'
import { certificateRouter } from './certificate'

const ctx = {
	session: null,
	ability: createMongoAbility([]),
	headers: new Headers(),
	db: {},
} as any

const resourceIdOrSlug = 'value-path:ai-hero-skills-workflow' as const
const verified = {
	id: '12345',
	email_address: 'reader@example.test',
	contactId: 'contact-reader',
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.session.mockResolvedValue({ session: null })
	mocks.linkSubscriber.mockResolvedValue(null)
	mocks.eligibility.mockResolvedValue({
		eligible: true,
		resourceIdOrSlug,
		contactId: 'contact-self',
		learnerName: 'Self',
		learnerEmail: 'self@example.test',
		completedAt: new Date('2026-11-01T00:00:00Z'),
	})
})

describe('certificate.valuePathEligibility', () => {
	it('looks nobody up for an anonymous caller with a bare subscriber id', async () => {
		const out = await certificateRouter.createCaller(ctx).valuePathEligibility({
			resourceIdOrSlug,
			kitSubscriberId: 12345,
			email: 'someone@example.test',
		})
		expect(out).toEqual({
			eligible: false,
			resourceIdOrSlug,
			reason: 'sign-in-required',
		})
		expect(mocks.eligibility).not.toHaveBeenCalled()
	})

	it('answers for a hash-verified link without returning a name or address', async () => {
		mocks.linkSubscriber.mockResolvedValue(verified)
		const out = await certificateRouter.createCaller(ctx).valuePathEligibility({
			resourceIdOrSlug,
			kitSubscriberId: 12345,
			shKit: 'a'.repeat(64),
			email: 'someone-else@example.test',
		})
		expect(mocks.linkSubscriber).toHaveBeenCalledWith({
			subscriberId: 12345,
			shKit: 'a'.repeat(64),
			route: '/survey',
		})
		expect(mocks.eligibility).toHaveBeenCalledWith({
			email: 'reader@example.test',
		})
		expect(out).toMatchObject({ eligible: true })
		expect(out).not.toHaveProperty('learnerName')
		expect(out).not.toHaveProperty('learnerEmail')
	})

	it('uses the session email and ignores the caller-supplied one', async () => {
		mocks.session.mockResolvedValue({
			session: { user: { id: 'u1', email: 'self@example.test' } },
		})
		const out = await certificateRouter.createCaller(ctx).valuePathEligibility({
			resourceIdOrSlug,
			email: 'someone-else@example.test',
		})
		expect(mocks.eligibility).toHaveBeenCalledWith({
			email: 'self@example.test',
		})
		expect(out).toMatchObject({ eligible: true, contactId: 'contact-self' })
		expect(out).not.toHaveProperty('learnerEmail')
	})
})

describe('ability subscriber procedures', () => {
	it('getCurrentSubscriberFromCookie returns the address-free gating payload', async () => {
		const payload = { state: 'active', fields: {}, hasIdentity: true }
		mocks.gating.mockResolvedValue(payload)
		const out = await abilityRouter
			.createCaller(ctx)
			.getCurrentSubscriberFromCookie()
		expect(out).toEqual(payload)
		expect(mocks.fullRecord).not.toHaveBeenCalled()
	})

	it('getVerifiedLinkSubscriber returns the address only for a verified link', async () => {
		const caller = abilityRouter.createCaller(ctx)
		expect(
			await caller.getVerifiedLinkSubscriber({
				shKit: 'b'.repeat(64),
				subscriberId: '12345',
			}),
		).toBeNull()
		mocks.linkSubscriber.mockResolvedValue(verified)
		expect(
			await caller.getVerifiedLinkSubscriber({
				shKit: 'a'.repeat(64),
				subscriberId: '12345',
			}),
		).toEqual({ id: '12345', email_address: 'reader@example.test' })
	})
})
