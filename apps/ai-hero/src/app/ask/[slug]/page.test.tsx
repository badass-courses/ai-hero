import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	verifyValuePathToken: vi.fn(),
	getValuePathAnswerPageBySlug: vi.fn(),
	recordValuePathAnswerProgression: vi.fn(),
	readActiveGateDRuntimeAllowlist: vi.fn(),
	resolveGateDPreAuthorizedReviewReasons: vi.fn(() => []),
	checkSkillsWorkflowValuePathCertificateEligibility: vi.fn(),
	ensureSkillsWorkflowCertificateShare: vi.fn(),
	inngestSend: vi.fn(),
	logError: vi.fn(),
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
	log: { error: mocks.logError, info: mocks.logInfo, warn: mocks.logWarn },
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
	vi.stubEnv('AI_HERO_VALUE_PATH_TOKEN_SECRET', 'test-value-path-token-secret')
	mocks.verifyValuePathToken.mockReturnValue({
		valid: true,
		payload: tokenPayload,
	})
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
	mocks.inngestSend.mockResolvedValue(undefined)
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
			resourceId: 'value-path:ai-hero-skills-workflow',
			courseName: 'AI Hero Skills Workflow',
			completedAt: new Date('2026-07-18T00:00:00.000Z'),
		},
	})
})

afterEach(() => {
	vi.unstubAllEnvs()
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

	it('lands on the certificate with an authentic token past expiresAt', async () => {
		const actualPathToken = await vi.importActual<
			typeof import('@/lib/subscriber-marketing/path-token')
		>('@/lib/subscriber-marketing/path-token')
		const expiredPayload = {
			...tokenPayload,
			expiresAt: '2020-01-01T00:00:00.000Z',
		}
		const expiredToken = actualPathToken.signValuePathToken({
			payload: expiredPayload,
			secret: 'test-value-path-token-secret',
		})
		mocks.verifyValuePathToken.mockImplementation(
			actualPathToken.verifyValuePathToken,
		)

		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: expiredToken, answer: 'other' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(mocks.verifyValuePathToken).toHaveBeenCalledWith({
			token: expiredToken,
			secret: 'test-value-path-token-secret',
			expirationPolicy: 'allow-expired',
		})
		expect(mocks.recordValuePathAnswerProgression).toHaveBeenCalledWith(
			expect.objectContaining({ token: expiredPayload }),
		)
		expect(markup).toContain('data-value-path-certificate="available"')
		expect(markup).toContain('Download PNG')
	})

	it('renders the certificate when answer progression fails after course completion', async () => {
		mocks.recordValuePathAnswerProgression.mockRejectedValue(
			new Error('Kit field write failed'),
		)
		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: 'signed-token', answer: 'other' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).toHaveBeenCalledWith({ contactId: 'contact-1' })
		expect(markup).toContain('data-value-path-certificate="available"')
		expect(markup).toContain('Noted. Your certificate is below.')
		expect(mocks.logError).toHaveBeenCalledWith(
			'value-path.ask.progression_failed',
			expect.objectContaining({ error: 'Kit field write failed' }),
		)
	})

	it('renders the certificate when the runtime allowlist cannot be read', async () => {
		mocks.readActiveGateDRuntimeAllowlist.mockRejectedValue(
			new Error('Redis unavailable'),
		)
		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: 'signed-token', answer: 'other' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(mocks.recordValuePathAnswerProgression).not.toHaveBeenCalled()
		expect(markup).toContain('data-value-path-certificate="available"')
		expect(mocks.logError).toHaveBeenCalledWith(
			'value-path.ask.allowlist_read_failed',
			expect.objectContaining({ error: 'Redis unavailable' }),
		)
	})

	it('renders the certificate when the answer event cannot be sent', async () => {
		mocks.inngestSend.mockRejectedValue(new Error('Inngest unavailable'))
		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: 'signed-token', answer: 'other' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain('data-value-path-certificate="available"')
		expect(mocks.logError).toHaveBeenCalledWith(
			'value-path.ask.answer_event_send_failed',
			expect.objectContaining({ error: 'Inngest unavailable' }),
		)
	})

	it('keeps team-email-7 on the same resilient certificate path', async () => {
		const teamTokenPayload = {
			...tokenPayload,
			valuePathResourceId: 'ai-hero-skills-team-workflow',
			emailResourceId: 'ai-hero-skills-team-workflow.team-email-7',
			sequenceId: 'ai-hero-skills-team-workflow',
		}
		mocks.verifyValuePathToken.mockReturnValue({
			valid: true,
			payload: teamTokenPayload,
		})
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue({
			...answerPage,
			fields: {
				...answerPage.fields,
				sequenceId: 'ai-hero-skills-team-workflow',
				emailId: 'team-email-7',
			},
		})
		mocks.recordValuePathAnswerProgression.mockRejectedValue(
			new Error('Kit field write failed'),
		)

		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({
				pt: 'team-signed-token',
				answer: 'other',
			}),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain('data-value-path-certificate="available"')
		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).toHaveBeenCalledWith({ contactId: 'contact-1' })
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

		expect(markup).toContain('data-value-path-certificate="share-unavailable"')
		expect(markup).toContain(
			'Your certificate is ready, but the share page could not load.',
		)
		expect(markup).not.toContain('/api/certificates?')
		expect(mocks.logWarn).toHaveBeenCalledWith(
			'value-path.certificate.share_unavailable',
			expect.objectContaining({ reason: 'share-persistence-failed' }),
		)
	})

	it('renders a graceful fallback when eligibility cannot be checked', async () => {
		mocks.checkSkillsWorkflowValuePathCertificateEligibility.mockRejectedValue(
			new Error('database unavailable'),
		)
		const page = await ValuePathAnswerPage({
			params: Promise.resolve({ slug: 'ai-hero-skills-workflow-certificate' }),
			searchParams: Promise.resolve({ pt: 'signed-token', answer: 'other' }),
		})
		const markup = renderToStaticMarkup(page)

		expect(markup).toContain(
			'data-value-path-certificate="eligibility-unavailable"',
		)
		expect(markup).toContain(
			'We could not load your certificate. Open this link again in a moment.',
		)
		expect(markup).not.toContain('/api/certificates?')
		expect(mocks.logError).toHaveBeenCalledWith(
			'value-path.certificate.eligibility_failed',
			expect.objectContaining({ error: 'database unavailable' }),
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
