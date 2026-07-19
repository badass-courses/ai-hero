import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	verifyValuePathToken: vi.fn(),
	getValuePathAnswerPageBySlug: vi.fn(),
	recordValuePathAnswerProgression: vi.fn(),
	readActiveGateDRuntimeAllowlist: vi.fn(),
	resolveGateDPreAuthorizedReviewReasons: vi.fn(() => []),
	checkSkillsWorkflowValuePathCertificateEligibility: vi.fn(),
	ensureSkillsWorkflowCertificateShare: vi.fn(),
	inngestSend: vi.fn(),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
}))

vi.mock('next/navigation', () => ({
	notFound: vi.fn(() => {
		throw new Error('not-found')
	}),
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {},
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/inngest/events/value-path', () => ({
	VALUE_PATH_ANSWER_SELECTED_EVENT: 'value-path/answer-selected',
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))
vi.mock('@/server/redis-client', () => ({ redis: {} }))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.logInfo, warn: mocks.logWarn },
}))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({
	DrizzleCaptureMarketingRepository: class {},
}))
vi.mock('@/lib/subscriber-marketing/path-token', () => ({
	verifyValuePathToken: mocks.verifyValuePathToken,
}))
vi.mock('@/lib/subscriber-marketing/value-path-answer-page', () => ({
	SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG:
		'ai-hero-skills-workflow-certificate',
	getValuePathAnswerPageBySlug: mocks.getValuePathAnswerPageBySlug,
}))
vi.mock('@/lib/subscriber-marketing/value-path-click-progression', () => ({
	recordValuePathAnswerProgression: mocks.recordValuePathAnswerProgression,
}))
vi.mock('@/lib/subscriber-marketing/value-path-email-executor', () => ({
	parseExecutorList: vi.fn(() => []),
}))
vi.mock('@/lib/subscriber-marketing/value-path-gate-d-allowlist', () => ({
	readActiveGateDRuntimeAllowlist: mocks.readActiveGateDRuntimeAllowlist,
	resolveGateDPreAuthorizedReviewReasons:
		mocks.resolveGateDPreAuthorizedReviewReasons,
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificates', () => ({
	checkSkillsWorkflowValuePathCertificateEligibility:
		mocks.checkSkillsWorkflowValuePathCertificateEligibility,
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificate-shares', () => ({
	SKILLS_WORKFLOW_CERTIFICATE_COURSE_NAME: 'AI Hero Skills Workflow',
	ensureSkillsWorkflowCertificateShare:
		mocks.ensureSkillsWorkflowCertificateShare,
	buildSkillsWorkflowCertificateShareUrl: vi.fn(
		({ slug }: { slug: string }) =>
			`https://www.aihero.dev/certificates/${slug}`,
	),
	buildSkillsWorkflowCertificateShareImageUrl: vi.fn(
		({ slug, download }: { slug: string; download?: boolean }) =>
			`/api/certificates?share=${slug}${download ? '&download=1' : ''}`,
	),
}))

import ValuePathAnswerPage from './page'

const tokenPayload = {
	contactId: 'contact-1',
	kitSubscriberId: 'kit-1',
	valuePathResourceId: 'ai-hero-skills-workflow',
	emailResourceId: 'ai-hero-skills-workflow.email-7',
	sequenceId: 'ai-hero-skills-workflow',
	expiresAt: '2026-08-18T00:00:00.000Z',
}

const answerPage = {
	id: 'ai-hero-skills-workflow.email-7-finisher-segment.other',
	type: 'value-path-page' as const,
	fields: {
		kind: 'answer' as const,
		slug: 'ai-hero-skills-workflow-certificate',
		sequenceId: 'ai-hero-skills-workflow',
		emailId: 'email-7',
		surveyId: 'email-7-finisher-segment',
		optionValue: 'other',
		result: 'other',
		headline: 'Noted. Your certificate is below.',
		nextNotice: 'You are on the waitlist for the next course.',
		captureFieldKey: 'aih_finisher_segment',
		captureDateFieldKey: 'aih_next_course_waitlist_at',
	},
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.verifyValuePathToken.mockReturnValue({ valid: true, payload: tokenPayload })
	mocks.getValuePathAnswerPageBySlug.mockResolvedValue(answerPage)
	mocks.readActiveGateDRuntimeAllowlist.mockResolvedValue({
		passed: true,
		allowlist: {
			mode: 'allowlisted-test',
			allowedActions: ['advance-by-answer-click'],
			contactIds: ['contact-1'],
			kitSubscriberIds: ['kit-1'],
			emails: ['fixture@example.com'],
			pathSlugs: ['ai-hero-skills-workflow'],
			emailResourceIds: ['ai-hero-skills-workflow.email-7'],
			kitSequenceIds: ['2831545'],
		},
	})
	mocks.recordValuePathAnswerProgression.mockResolvedValue({
		status: 'recorded',
		contactEventId: 'event-1',
		idempotentNoop: false,
		reviewReasons: [],
		finisherCapture: 'written',
	})
	mocks.checkSkillsWorkflowValuePathCertificateEligibility.mockResolvedValue({
		eligible: true,
		resourceIdOrSlug: 'value-path:ai-hero-skills-workflow',
		contactId: 'contact-1',
		learnerName: 'Joel Hooks',
		completedAt: new Date('2026-07-18T00:00:00.000Z'),
	})
	mocks.ensureSkillsWorkflowCertificateShare.mockResolvedValue({
		available: true,
		created: true,
		share: {
			slug: 'opaque-public-certificate-slug-123',
			learnerName: 'Joel Hooks',
			courseName: 'AI Hero Skills Workflow',
			completedAt: new Date('2026-07-18T00:00:00.000Z'),
		},
	})
})

describe('Email 7 certificate answer landing page', () => {
	it('records the selected variant, then renders the certificate trophy and safe share actions', async () => {
		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: 'signed-token', answer: 'other' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(mocks.getValuePathAnswerPageBySlug).toHaveBeenCalledWith({
			slug: 'ai-hero-skills-workflow-certificate',
			optionValue: 'other',
			sequenceId: 'ai-hero-skills-workflow',
			emailId: 'email-7',
		})
		expect(mocks.recordValuePathAnswerProgression).toHaveBeenCalledWith(
			expect.objectContaining({
				token: tokenPayload,
				answerPage,
				mode: 'allowlisted-test',
			}),
		)
		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).toHaveBeenCalledWith({ contactId: 'contact-1' })
		expect(mocks.ensureSkillsWorkflowCertificateShare).toHaveBeenCalledWith({
			eligibility: expect.objectContaining({
				eligible: true,
				contactId: 'contact-1',
			}),
		})
		expect(markup).toContain('You finished the AI Hero Skills Workflow.')
		expect(markup).toContain('Noted. Your certificate is below.')
		expect(markup).toContain('You are on the waitlist for the next course.')
		expect(markup).toContain('data-value-path-certificate="available"')
		expect(markup).toContain('Download PNG')
		expect(markup).toContain(
			'/api/certificates?share=opaque-public-certificate-slug-123',
		)
		expect(markup).toContain(
			'https://www.aihero.dev/certificates/opaque-public-certificate-slug-123',
		)
		expect(markup).toContain('Share on X')
		expect(markup).toContain('LinkedIn')
		expect(markup).toContain('Copy link')
		expect(markup).not.toContain('signed-token')
		expect(markup).not.toContain('contact-1')
		expect(markup).not.toContain('pt=')
	})

	it('does not reveal the certificate when the answer could not be recorded', async () => {
		mocks.recordValuePathAnswerProgression.mockResolvedValue({
			status: 'skipped',
			reason: 'finisher-capture-action-not-authorized',
			idempotentNoop: false,
			reviewReasons: ['advance-by-answer-click-not-allowed'],
		})
		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: 'signed-token', answer: 'other' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).not.toHaveBeenCalled()
		expect(markup).toContain(
			'data-value-path-certificate="answer-not-recorded"',
		)
		expect(markup).toContain(
			'We could not save your answer. Open the link again in a moment.',
		)
		expect(mocks.ensureSkillsWorkflowCertificateShare).not.toHaveBeenCalled()
		expect(markup).not.toContain('/api/certificates?')
	})

	it('contains share persistence failure without losing the signed landing page', async () => {
		mocks.ensureSkillsWorkflowCertificateShare.mockRejectedValue(
			new Error('database unavailable'),
		)
		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: 'signed-token', answer: 'shipping' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain(
			'data-value-path-certificate="share-unavailable"',
		)
		expect(markup).toContain(
			'Your certificate is ready, but the share page could not load.',
		)
		expect(markup).not.toContain('/api/certificates?')
		expect(mocks.logWarn).toHaveBeenCalledWith(
			'value-path.certificate.share_unavailable',
			expect.objectContaining({ reason: 'share-persistence-failed' }),
		)
	})

	it('renders a useful fallback without exposing a certificate URL when incomplete', async () => {
		mocks.checkSkillsWorkflowValuePathCertificateEligibility.mockResolvedValue({
			eligible: false,
			resourceIdOrSlug: 'value-path:ai-hero-skills-workflow',
			contactId: 'contact-1',
			reason: 'value-path-not-complete',
		})
		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: 'signed-token', answer: 'shipping' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain('data-value-path-certificate="ineligible"')
		expect(markup).toContain(
			'Your certificate unlocks after you complete the full Skills Workflow.',
		)
		expect(mocks.ensureSkillsWorkflowCertificateShare).not.toHaveBeenCalled()
		expect(markup).not.toContain('/api/certificates?')
	})
})
