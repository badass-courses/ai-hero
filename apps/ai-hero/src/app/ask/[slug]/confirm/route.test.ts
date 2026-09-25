import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	verifyValuePathToken: vi.fn(),
	getValuePathAnswerPageBySlug: vi.fn(),
	recordValuePathAnswerProgression: vi.fn(),
	readActiveGateDRuntimeAllowlist: vi.fn(),
	checkSkillsWorkflowValuePathCertificateEligibility: vi.fn(),
	ensureSkillsWorkflowCertificateShare: vi.fn(),
	inngestSend: vi.fn(),
	logError: vi.fn(),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
}))

vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: {},
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/inngest/events/value-path', () => ({
	VALUE_PATH_ANSWER_SELECTED_EVENT: 'value-path/answer.selected',
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { send: mocks.inngestSend },
}))
vi.mock('@/server/redis-client', () => ({ redis: {} }))
vi.mock('@/server/with-skill', () => ({
	withSkill: <Handler>(handler: Handler) => handler,
}))
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
	resolveGateDPreAuthorizedReviewReasons: vi.fn(() => []),
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificates', () => ({
	checkSkillsWorkflowValuePathCertificateEligibility:
		mocks.checkSkillsWorkflowValuePathCertificateEligibility,
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificate-shares', () => ({
	ensureSkillsWorkflowCertificateShare:
		mocks.ensureSkillsWorkflowCertificateShare,
}))

import { POST } from './route'

const tokenPayload = {
	contactId: 'contact-1',
	kitSubscriberId: 'kit-1',
	valuePathResourceId: 'ai-hero-skills-workflow',
	emailResourceId: 'ai-hero-skills-workflow.email-3',
	sequenceId: 'ai-hero-skills-workflow',
	expiresAt: '2026-10-18T00:00:00.000Z',
}
const answerPage = {
	id: 'skills-workflow.email-3-correct',
	type: 'value-path-page' as const,
	fields: {
		kind: 'answer' as const,
		slug: 'skills-workflow-email-3-correct',
		sequenceId: 'ai-hero-skills-workflow',
		emailId: 'email-3',
		optionValue: 'correct',
	},
}
const recorded = {
	status: 'recorded',
	contactEventId: 'event-1',
	idempotentNoop: false,
	reviewReasons: [],
}

// In memory, the progression the real recorder keeps: once per answer.
let recordedAnswers: Set<string>

function confirm(
	slug = 'skills-workflow-email-3-correct',
	body: Record<string, string> = { pt: 'signed-token', answer: 'correct' },
) {
	return POST(
		new NextRequest(`https://www.aihero.dev/ask/${slug}/confirm`, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(body).toString(),
		}),
		{ params: Promise.resolve({ slug }) },
	)
}

beforeEach(() => {
	vi.clearAllMocks()
	recordedAnswers = new Set()
	mocks.verifyValuePathToken.mockReturnValue({
		valid: true,
		payload: tokenPayload,
	})
	mocks.getValuePathAnswerPageBySlug.mockResolvedValue(answerPage)
	mocks.readActiveGateDRuntimeAllowlist.mockResolvedValue({
		passed: true,
		allowlist: {
			mode: 'rolling-public-enrollment',
			allowedActions: ['advance-by-answer-click'],
			contactIds: [],
			kitSubscriberIds: [],
			emails: [],
			pathSlugs: ['ai-hero-skills-workflow'],
			emailResourceIds: [],
			kitSequenceIds: [],
		},
	})
	mocks.recordValuePathAnswerProgression.mockImplementation(
		async ({ answerPage: page }: { answerPage: { id: string } }) => {
			if (recordedAnswers.has(page.id)) {
				return { status: 'idempotent-noop', idempotentNoop: true, reviewReasons: [] }
			}
			recordedAnswers.add(page.id)
			return recorded
		},
	)
	mocks.inngestSend.mockResolvedValue(undefined)
})

describe('POST /ask/{slug}/confirm records the answer', () => {
	it('records once, emits the answer event once, and 303s to the confirmed view', async () => {
		const response = await confirm()

		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toBe(
			'https://www.aihero.dev/ask/skills-workflow-email-3-correct?answer=correct&pt=signed-token&confirmed=1',
		)
		expect(mocks.getValuePathAnswerPageBySlug).toHaveBeenCalledWith({
			slug: 'skills-workflow-email-3-correct',
			optionValue: 'correct',
			sequenceId: 'ai-hero-skills-workflow',
			emailId: 'email-3',
		})
		expect(mocks.recordValuePathAnswerProgression).toHaveBeenCalledTimes(1)
		expect(mocks.recordValuePathAnswerProgression).toHaveBeenCalledWith(
			expect.objectContaining({ token: tokenPayload, answerPage }),
		)
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
		expect(mocks.inngestSend).toHaveBeenCalledWith({
			name: 'value-path/answer.selected',
			data: {
				contactId: 'contact-1',
				valuePathSlug: 'ai-hero-skills-workflow',
				sentEmailResourceId: 'ai-hero-skills-workflow.email-3',
				answerPageId: 'skills-workflow.email-3-correct',
				contactEventId: 'event-1',
			},
		})
	})

	it('is idempotent: a repeat POST gives the same redirect and no second event', async () => {
		const first = await confirm()
		const second = await confirm()

		expect(second.status).toBe(303)
		expect(second.headers.get('location')).toBe(first.headers.get('location'))
		expect(mocks.recordValuePathAnswerProgression).toHaveBeenCalledTimes(2)
		expect(mocks.inngestSend).toHaveBeenCalledTimes(1)
	})

	it('records nothing for an invalid pt and sends the reader back to the landing', async () => {
		mocks.verifyValuePathToken.mockReturnValue({ valid: false, reason: 'tampered' })
		const response = await confirm()

		expect(response.status).toBe(303)
		expect(response.headers.get('location')).not.toContain('confirmed=1')
		expect(mocks.recordValuePathAnswerProgression).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
	})

	it('404s an unknown answer page without recording', async () => {
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue(null)
		const response = await confirm('no-such-answer')

		expect(response.status).toBe(404)
		expect(mocks.recordValuePathAnswerProgression).not.toHaveBeenCalled()
	})

	it('records nothing without the Gate D allowlist, and says why', async () => {
		mocks.readActiveGateDRuntimeAllowlist.mockResolvedValue({
			passed: false,
			reviewReasons: ['gate-d-allowlist-missing'],
		})
		const response = await confirm()

		expect(response.status).toBe(303)
		expect(mocks.recordValuePathAnswerProgression).not.toHaveBeenCalled()
		expect(mocks.inngestSend).not.toHaveBeenCalled()
		expect(mocks.logWarn).toHaveBeenCalledWith(
			'value-path.ask.authorization_blocked',
			expect.objectContaining({ contactId: 'contact-1' }),
		)
	})

	it('still lands on the confirmed view when the event cannot be sent', async () => {
		mocks.inngestSend.mockRejectedValue(new Error('inngest down'))
		const response = await confirm()

		expect(response.status).toBe(303)
		expect(response.headers.get('location')).toContain('confirmed=1')
		expect(mocks.logError).toHaveBeenCalledWith(
			'value-path.ask.answer_event_send_failed',
			expect.objectContaining({ contactEventId: 'event-1' }),
		)
	})

	it('creates the finisher certificate share on confirm, never for a synthetic principal', async () => {
		const certificate = {
			...answerPage,
			id: 'email-7-finisher.other',
			fields: { ...answerPage.fields, emailId: 'email-7', slug: 'cert' },
		}
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue(certificate)
		mocks.checkSkillsWorkflowValuePathCertificateEligibility.mockResolvedValue({
			eligible: true,
			contactId: 'contact-1',
			learnerName: 'A Learner',
			completedAt: new Date('2026-09-20T00:00:00.000Z'),
		})
		mocks.ensureSkillsWorkflowCertificateShare.mockResolvedValue({
			available: true,
			created: true,
			share: { slug: 's' },
		})

		await confirm('cert', { pt: 'signed-token', answer: 'other' })
		expect(mocks.ensureSkillsWorkflowCertificateShare).toHaveBeenCalledTimes(1)

		vi.clearAllMocks()
		mocks.verifyValuePathToken.mockReturnValue({
			valid: true,
			payload: { ...tokenPayload, contactId: 'synthetic_run-1' },
		})
		mocks.getValuePathAnswerPageBySlug.mockResolvedValue(certificate)
		mocks.readActiveGateDRuntimeAllowlist.mockResolvedValue({ passed: false })
		await confirm('cert', { pt: 'signed-token', answer: 'other' })
		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).not.toHaveBeenCalled()
		expect(mocks.ensureSkillsWorkflowCertificateShare).not.toHaveBeenCalled()
	})

	it('never logs an email address', async () => {
		await confirm()
		const logged = JSON.stringify([
			mocks.logInfo.mock.calls,
			mocks.logWarn.mock.calls,
			mocks.logError.mock.calls,
		])
		expect(logged).not.toContain('@')
	})
})
