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
	findSkillsWorkflowCertificateShare: vi.fn(),
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
	findSkillsWorkflowCertificateShare: mocks.findSkillsWorkflowCertificateShare,
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
			courseName: 'AI Hero Skills Workflow',
			completedAt: new Date('2026-07-18T00:00:00.000Z'),
		},
	})
})

beforeEach(() => {
	mocks.findSkillsWorkflowCertificateShare.mockResolvedValue({
		slug: 'opaque-public-certificate-slug-123',
		learnerName: 'Joel Hooks',
		courseName: 'AI Hero Skills Workflow',
		completedAt: new Date('2026-07-18T00:00:00.000Z'),
	})
})

afterEach(() => {
	vi.unstubAllEnvs()
})

const genericAnswerPage = {
	id: 'skills-workflow.email-3-correct',
	type: 'value-path-page' as const,
	fields: {
		kind: 'answer' as const,
		slug: 'skills-workflow-email-3-correct',
		sequenceId: 'ai-hero-skills-workflow',
		emailId: 'email-3',
		optionValue: 'correct',
		title: 'Ship it on Friday',
		headline: 'Good answer.',
	},
}

async function render(
	slug: string,
	searchParams: {
		pt?: string
		answer?: string
		confirmed?: string
		retry?: string
	},
) {
	return renderToStaticMarkup(
		await ValuePathAnswerPage({
			params: Promise.resolve({ slug }),
			searchParams: Promise.resolve(searchParams),
		}),
	)
}

/** Nothing a mail gateway's fetch may cause: no record, no event, no write. */
function expectNothingRecorded() {
	expect(mocks.recordValuePathAnswerProgression).not.toHaveBeenCalled()
	expect(mocks.readActiveGateDRuntimeAllowlist).not.toHaveBeenCalled()
	expect(mocks.inngestSend).not.toHaveBeenCalled()
	expect(mocks.ensureSkillsWorkflowCertificateShare).not.toHaveBeenCalled()
}

describe('answer link GET records nothing (mail gateways fetch links)', () => {
	it('renders the chosen answer and a confirm button that POSTs pt and answer', async () => {
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue(genericAnswerPage)
		const markup = await render('skills-workflow-email-3-correct', {
			pt: 'signed-token',
			answer: 'correct',
		})

		expectNothingRecorded()
		expect(markup).toMatch(/<main[^>]*data-value-path-token="valid"/)
		expect(markup).toContain('data-value-path-answer="unconfirmed"')
		expect(markup).toContain('Confirm your answer')
		expect(markup).toContain('Ship it on Friday')
		expect(markup).toMatch(
			/<form[^>]*action="\/ask\/skills-workflow-email-3-correct\/confirm"[^>]*method="post"/,
		)
		expect(markup).toMatch(/<input[^>]*name="pt"[^>]*value="signed-token"/)
		expect(markup).toMatch(/<input[^>]*name="answer"[^>]*value="correct"/)
		expect(markup).not.toContain('contact-1')
	})

	it('re-offers Confirm with a note after a failed save, still recording nothing', async () => {
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue(genericAnswerPage)
		const markup = await render('skills-workflow-email-3-correct', {
			pt: 'signed-token',
			answer: 'correct',
			retry: '1',
		})

		expectNothingRecorded()
		expect(markup).toContain('We could not save your answer.')
		expect(markup).toMatch(/<input[^>]*name="pt"[^>]*value="signed-token"/)
		expect(markup).toMatch(/<input[^>]*name="answer"[^>]*value="correct"/)
	})

	it('records nothing on the certificate answer either, and creates no share', async () => {
		const markup = await render('ai-hero-skills-workflow-certificate', {
			pt: 'signed-token',
			answer: 'other',
		})

		expectNothingRecorded()
		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).not.toHaveBeenCalled()
		expect(markup).toContain('Confirm your answer')
		expect(markup).not.toContain('data-value-path-certificate')
	})

	it('records nothing for an invalid pt and offers no confirm', async () => {
		mocks.verifyValuePathToken.mockReturnValue({ valid: false, reason: 'tampered' })
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue(genericAnswerPage)
		const markup = await render('skills-workflow-email-3-correct', {
			pt: 'bad-token',
			answer: 'correct',
		})

		expectNothingRecorded()
		expect(markup).toMatch(/<main[^>]*data-value-path-token="invalid"/)
		expect(markup).toContain('Good answer.')
		expect(markup).not.toContain('<form')
	})

	it('records nothing when a fetch replays the confirmed view', async () => {
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue(genericAnswerPage)
		const markup = await render('skills-workflow-email-3-correct', {
			pt: 'signed-token',
			answer: 'correct',
			confirmed: '1',
		})

		expectNothingRecorded()
		expect(markup).toMatch(/<main[^>]*data-value-path-token="valid"/)
		expect(markup).toContain('Good answer.')
		expect(markup).toContain('data-value-path-answer="confirmed"')
		expect(markup).not.toContain('signed-token')
	})
})

describe('confirmed Email 7 certificate view (read-only)', () => {
	const confirmedCertificate = () =>
		render('ai-hero-skills-workflow-certificate', {
			pt: 'signed-token',
			answer: 'other',
			confirmed: '1',
		})

	it('renders the trophy from the existing share, with safe share actions', async () => {
		const markup = await confirmedCertificate()

		expectNothingRecorded()
		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).toHaveBeenCalledWith({ contactId: 'contact-1' })
		expect(mocks.findSkillsWorkflowCertificateShare).toHaveBeenCalledWith(
			'contact-1',
		)
		expect(markup).toContain('You finished the AI Hero Skills Workflow.')
		expect(markup).toContain('Noted. Your certificate is below.')
		expect(markup).toContain('data-value-path-certificate="available"')
		expect(markup).toContain('Download PNG')
		expect(markup).toContain(
			'https://www.aihero.dev/certificates/opaque-public-certificate-slug-123',
		)
		expect(markup).toContain('Share on X')
		expect(markup).not.toContain('signed-token')
		expect(markup).not.toContain('contact-1')
		expect(markup).not.toContain('pt=')
	})

	it('lands on the certificate with an authentic token past expiresAt', async () => {
		const actualPathToken = await vi.importActual<
			typeof import('@/lib/subscriber-marketing/path-token')
		>('@/lib/subscriber-marketing/path-token')
		const expiredToken = actualPathToken.signValuePathToken({
			payload: { ...tokenPayload, expiresAt: '2020-01-01T00:00:00.000Z' },
			secret: 'test-value-path-token-secret',
		})
		mocks.verifyValuePathToken.mockImplementation(
			actualPathToken.verifyValuePathToken,
		)

		const markup = await render('ai-hero-skills-workflow-certificate', {
			pt: expiredToken,
			answer: 'other',
			confirmed: '1',
		})

		expect(mocks.verifyValuePathToken).toHaveBeenCalledWith({
			token: expiredToken,
			secret: 'test-value-path-token-secret',
			expirationPolicy: 'allow-expired',
		})
		expect(markup).toContain('data-value-path-certificate="available"')
	})

	it('keeps team-email-7 on the certificate path', async () => {
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue({
			...answerPage,
			fields: { ...answerPage.fields, emailId: 'team-email-7' },
		})
		const markup = await confirmedCertificate()

		expect(markup).toContain('data-value-path-certificate="available"')
	})

	it('offers a retry when the share is not there yet', async () => {
		mocks.findSkillsWorkflowCertificateShare.mockResolvedValue(null)
		const markup = await confirmedCertificate()

		expect(markup).toContain('data-value-path-certificate="share-unavailable"')
		expect(markup).toContain('Try again')
		expect(markup).not.toContain('/api/certificates?')
	})

	it('renders a graceful fallback when eligibility cannot be checked', async () => {
		mocks.checkSkillsWorkflowValuePathCertificateEligibility.mockRejectedValue(
			new Error('database unavailable'),
		)
		const markup = await confirmedCertificate()

		expect(markup).toContain(
			'data-value-path-certificate="eligibility-unavailable"',
		)
		expect(markup).not.toContain('/api/certificates?')
	})

	it('renders a useful fallback without exposing a certificate URL when incomplete', async () => {
		mocks.checkSkillsWorkflowValuePathCertificateEligibility.mockResolvedValue({
			eligible: false,
			reason: 'course-incomplete',
		})
		const markup = await confirmedCertificate()

		expect(markup).toContain('data-value-path-certificate="ineligible"')
		expect(mocks.findSkillsWorkflowCertificateShare).not.toHaveBeenCalled()
		expect(markup).not.toContain('/api/certificates?')
	})

	it('never checks eligibility for a synthetic principal', async () => {
		mocks.verifyValuePathToken.mockReturnValue({
			valid: true,
			payload: { ...tokenPayload, contactId: 'synthetic_run-1' },
		})
		const markup = await confirmedCertificate()

		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).not.toHaveBeenCalled()
		expect(mocks.findSkillsWorkflowCertificateShare).not.toHaveBeenCalled()
		expect(markup).toMatch(/<main[^>]*data-value-path-token="valid"/)
	})
})
