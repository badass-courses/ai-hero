import { createMongoAbility } from '@casl/ability'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	eligibility: vi.fn(),
	gating: vi.fn(),
	fullRecord: vi.fn(),
}))
vi.mock('@/db', () => ({ courseBuilderAdapter: {}, db: {} }))
vi.mock('@/lib/certificates', () => ({
	checkCohortCertificateEligibility: vi.fn(),
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificates', () => ({
	checkSkillsWorkflowValuePathCertificateEligibility: mocks.eligibility,
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

beforeEach(() => {
	vi.clearAllMocks()
	mocks.session.mockResolvedValue({ session: null })
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
	it('tells an anonymous caller to sign in and looks nobody up', async () => {
		const out = await certificateRouter
			.createCaller(ctx)
			.valuePathEligibility({ resourceIdOrSlug, kitSubscriberId: 12345 })
		expect(out).toEqual({
			eligible: false,
			resourceIdOrSlug,
			reason: 'sign-in-required',
		})
		expect(mocks.eligibility).not.toHaveBeenCalled()
	})

	it('answers for the session email only and returns no name or address', async () => {
		mocks.session.mockResolvedValue({
			session: { user: { id: 'u1', email: 'self@example.test' } },
		})
		const out = await certificateRouter.createCaller(ctx).valuePathEligibility({
			resourceIdOrSlug,
			kitSubscriberId: 12345,
			email: 'someone-else@example.test',
		})
		expect(mocks.eligibility).toHaveBeenCalledWith({
			email: 'self@example.test',
		})
		expect(out).toMatchObject({ eligible: true, contactId: 'contact-self' })
		expect(out).not.toHaveProperty('learnerName')
		expect(out).not.toHaveProperty('learnerEmail')
	})
})

describe('ability.getCurrentSubscriberFromCookie', () => {
	it('returns the address-free gating payload, not the Kit record', async () => {
		const payload = { state: 'active', fields: {}, hasIdentity: true }
		mocks.gating.mockResolvedValue(payload)
		const out = await abilityRouter
			.createCaller(ctx)
			.getCurrentSubscriberFromCookie()
		expect(out).toEqual(payload)
		expect(mocks.fullRecord).not.toHaveBeenCalled()
	})
})
