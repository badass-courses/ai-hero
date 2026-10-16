import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	contact: vi.fn(),
	identity: vi.fn(),
	intents: vi.fn(),
	delivery: vi.fn(),
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			contact: { findFirst: mocks.contact },
			providerIdentity: { findFirst: mocks.identity },
			sideEffectIntent: { findMany: mocks.intents },
		},
	},
}))
vi.mock('./drovr-certificate-completion', () => ({
	readDrovrCertificateCompletion: mocks.delivery,
}))
import { checkSkillsWorkflowValuePathCertificateEligibility as check } from './value-path-certificates'
const date = '2026-07-18T12:00:00.000Z'
const email6 = 'ai-hero-skills-workflow.email-6'
beforeEach(() => {
	vi.resetAllMocks()
	mocks.contact.mockResolvedValue({
		id: 'test-contact',
		name: null,
		email: 'learner@example.test',
	})
	mocks.intents.mockResolvedValue([])
	mocks.delivery.mockResolvedValue({ status: 'not-completed' })
})
describe('shared certificate eligibility', () => {
	it.each([email6, 'ai-hero-skills-team-workflow.team-email-6'])(
		'preserves canonical and legacy timestamps for %s',
		async (emailResourceId) => {
			for (const canonical of [true, false]) {
				mocks.intents.mockResolvedValue([
					{
						status: 'completed',
						completedAt: canonical ? date : null,
						metadata: {
							emailResourceId,
							completedAt: canonical ? undefined : date,
						},
					},
				])
				expect(await check({ contactId: 'test-contact' })).toMatchObject({
					eligible: true,
					learnerName: 'learner@example.test',
					completedAt: new Date(date),
				})
				expect(mocks.delivery).not.toHaveBeenCalled()
			}
		},
	)
	it('uses email 6 delivery date without legacy intents', async () => {
		mocks.delivery.mockResolvedValue({
			status: 'completed',
			completedAt: new Date(date),
		})
		expect(await check({ contactId: 'test-contact' })).toMatchObject({
			eligible: true,
			completedAt: new Date(date),
			learnerName: 'learner@example.test',
		})
		expect(mocks.delivery).toHaveBeenCalledWith('test-contact')
	})
	it.each([
		{
			status: 'pending',
			completedAt: date,
			metadata: { emailResourceId: email6 },
		},
		{
			status: 'failed',
			completedAt: date,
			metadata: { emailResourceId: email6 },
		},
		{
			status: 'completed',
			completedAt: null,
			metadata: { emailResourceId: email6 },
		},
		{
			status: 'completed',
			completedAt: 'bad',
			metadata: { emailResourceId: email6 },
		},
		{
			status: 'completed',
			completedAt: '2999-01-01',
			metadata: { emailResourceId: email6 },
		},
		...[0, 1, 2, 3, 4, 5, 7].map((n) => ({
			status: 'completed',
			completedAt: date,
			metadata: { emailResourceId: `ai-hero-skills-workflow.email-${n}` },
		})),
		{
			status: 'pending',
			metadata: { emailResourceId: 'ai-hero-skills-workflow.email-7' },
		},
	])(
		'does not grant non-terminal or invalid legacy evidence %j',
		async (intent) => {
			mocks.intents.mockResolvedValue([intent])
			expect(await check({ contactId: 'test-contact' })).toMatchObject({
				eligible: false,
				reason: 'value-path-not-complete',
			})
			expect(mocks.delivery).toHaveBeenCalledTimes(1)
		},
	)
	it('does not use subscription or ownership as completion', async () => {
		mocks.contact.mockResolvedValue({
			id: 'test-contact',
			email: 'learner@example.test',
			owner: 'skills',
			subscribed: true,
		})
		expect(await check({ contactId: 'test-contact' })).toMatchObject({
			eligible: false,
			reason: 'value-path-not-complete',
		})
	})
	it('distinguishes provider outage from non-completion', async () => {
		mocks.delivery.mockResolvedValue({ status: 'unavailable' })
		expect(await check({ contactId: 'test-contact' })).toMatchObject({
			eligible: false,
			reason: 'completion-evidence-unavailable',
		})
	})
	it('keeps missing contact ineligible without provider lookup', async () => {
		mocks.contact.mockResolvedValue(null)
		expect(await check({ contactId: 'missing' })).toMatchObject({
			eligible: false,
			reason: 'contact-not-found',
		})
		expect(mocks.delivery).not.toHaveBeenCalled()
	})
	it('preserves identity resolution and named learner', async () => {
		mocks.identity.mockResolvedValue({ contactId: 'test-contact' })
		mocks.contact.mockResolvedValue({
			id: 'test-contact',
			name: 'Test Learner',
			email: 'learner@example.test',
		})
		mocks.delivery.mockResolvedValue({
			status: 'completed',
			completedAt: new Date(date),
		})
		expect(await check({ kitSubscriberId: 123 })).toMatchObject({
			eligible: true,
			contactId: 'test-contact',
			learnerName: 'Test Learner',
		})
	})
})
