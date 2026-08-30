import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getPublicSkillsWorkflowCertificateShare: vi.fn(),
	checkSkillsWorkflowValuePathCertificateEligibility: vi.fn(),
	checkCertificateEligibility: vi.fn(),
	isSkillsWorkflowCertificateResource: vi.fn(),
	isCrashCourseCertificateV1Enabled: vi.fn(),
	readCrashCourseCertificateGate: vi.fn(),
	getServerAuthSession: vi.fn(),
	imageResponse: vi.fn(),
	readFile: vi.fn(),
	contentResourceFindFirst: vi.fn(),
	userFindFirst: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))
vi.mock('next/og', () => ({
	ImageResponse: class {
		constructor(element: React.ReactNode, options: Record<string, any>) {
			mocks.imageResponse(element, options)
			return new Response('png', {
				headers: {
					'Content-Type': 'image/png',
					...(options.headers ?? {}),
				},
			})
		}
	},
}))
vi.mock('@/db', () => ({
	db: {
		query: {
			contentResource: { findFirst: mocks.contentResourceFindFirst },
			users: { findFirst: mocks.userFindFirst },
		},
	},
}))
vi.mock('@/lib/certificates', () => ({
	checkCertificateEligibility: mocks.checkCertificateEligibility,
	checkCohortCertificateEligibility: vi.fn(),
}))
vi.mock('@/lib/crash-course-certificate-gate', () => ({
	isCrashCourseCertificateV1Enabled: mocks.isCrashCourseCertificateV1Enabled,
	readCrashCourseCertificateGate: mocks.readCrashCourseCertificateGate,
}))
vi.mock('@/lib/crash-course-certificate-eligibility', () => ({
	AI_CODING_CRASH_COURSE_FINAL_QUIZ: {
		courseResourceId: 'workshop-2ozd9',
	},
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificates', () => ({
	checkSkillsWorkflowValuePathCertificateEligibility:
		mocks.checkSkillsWorkflowValuePathCertificateEligibility,
	isSkillsWorkflowCertificateResource:
		mocks.isSkillsWorkflowCertificateResource,
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificate-shares', () => ({
	getPublicSkillsWorkflowCertificateShare:
		mocks.getPublicSkillsWorkflowCertificateShare,
}))

import { GET } from './route'

beforeEach(() => {
	vi.clearAllMocks()
	mocks.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]))
	mocks.isSkillsWorkflowCertificateResource.mockImplementation(
		(resource: string) => resource === 'value-path:ai-hero-skills-workflow',
	)
	mocks.isCrashCourseCertificateV1Enabled.mockReturnValue(false)
	mocks.getPublicSkillsWorkflowCertificateShare.mockResolvedValue({
		slug: 'opaque-public-certificate-slug-123',
		resourceId: 'value-path:ai-hero-skills-workflow',
		learnerName: 'Joel Hooks',
		courseName: 'AI Hero Skills Workflow',
		completedAt: new Date('2026-07-18T12:00:00.000Z'),
	})
})

describe('Crash Course certificate PNG', () => {
	beforeEach(() => {
		mocks.isCrashCourseCertificateV1Enabled.mockReturnValue(true)
		mocks.getPublicSkillsWorkflowCertificateShare.mockResolvedValue(null)
		mocks.contentResourceFindFirst.mockResolvedValue({
			id: 'workshop-2ozd9',
			type: 'workshop',
			fields: { title: 'AI Coding Crash Course' },
		})
		mocks.getServerAuthSession.mockResolvedValue({
			session: { user: { id: 'user-1' } },
		})
		mocks.userFindFirst.mockResolvedValue({
			id: 'user-1',
			name: 'Joel Hooks',
			email: 'joel@example.com',
		})
	})

	it('preserves the existing lesson-progress path while rollout is disabled', async () => {
		mocks.isCrashCourseCertificateV1Enabled.mockReturnValue(false)
		mocks.checkCertificateEligibility.mockResolvedValue({
			hasCompletedModule: true,
			date: new Date('2026-08-29T12:00:00.000Z'),
		})
		mocks.userFindFirst.mockResolvedValue({
			id: 'legacy-user',
			name: 'Legacy Learner',
			email: 'legacy@example.com',
		})

		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?resource=ai-coding-crash-course&user=legacy-user',
			),
		)

		expect(response.status).toBe(200)
		expect(mocks.checkCertificateEligibility).toHaveBeenCalledWith(
			'ai-coding-crash-course',
			'legacy-user',
		)
		expect(mocks.getServerAuthSession).not.toHaveBeenCalled()
		expect(mocks.readCrashCourseCertificateGate).not.toHaveBeenCalled()
	})

	it('ignores caller-selected identity and renders for the session learner', async () => {
		mocks.readCrashCourseCertificateGate.mockResolvedValue({
			status: 'granted',
			eligibility: {
				eligible: true,
				userId: 'user-1',
				courseResourceId: 'workshop-2ozd9',
				finalQuizLessonId: 'sync_lesson_800b577c51997b78aa74a65c',
				completedAt: new Date('2026-08-30T12:00:07.000Z'),
				correctAnswers: 8,
				requiredAnswers: 8,
			},
		})

		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?resource=ai-coding-crash-course&user=attacker',
			),
		)

		expect(response.status).toBe(200)
		expect(mocks.readCrashCourseCertificateGate).toHaveBeenCalledWith({
			userId: 'user-1',
		})
		expect(
			JSON.stringify(mocks.imageResponse.mock.calls[0]?.[0]),
		).not.toContain('attacker')
	})

	it('returns an actionable lock without rendering', async () => {
		mocks.readCrashCourseCertificateGate.mockResolvedValue({
			status: 'locked',
			reason: 'answers-missing',
			correctAnswers: 5,
			requiredAnswers: 8,
		})

		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?resource=ai-coding-crash-course',
			),
		)

		expect(response.status).toBe(422)
		await expect(response.json()).resolves.toEqual({
			error: 'Certificate checkpoint incomplete',
			reason: 'answers-missing',
			correctAnswers: 5,
			requiredAnswers: 8,
		})
		expect(mocks.imageResponse).not.toHaveBeenCalled()
	})

	it('returns temporary unavailability for configuration or query failure', async () => {
		mocks.readCrashCourseCertificateGate.mockResolvedValue({
			status: 'unavailable',
			reason: 'final-quiz-question-set-mismatch',
		})

		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?resource=ai-coding-crash-course',
			),
		)

		expect(response.status).toBe(503)
		await expect(response.json()).resolves.toEqual({
			error: 'Certificate check temporarily unavailable',
		})
		expect(mocks.imageResponse).not.toHaveBeenCalled()
	})
})

describe('public certificate PNG', () => {
	it('renders from the opaque share slug without reading contact identity', async () => {
		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?share=opaque-public-certificate-slug-123&user=contact-must-not-leak&resource=value-path%3Aai-hero-skills-workflow',
			),
		)

		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('image/png')
		expect(mocks.getPublicSkillsWorkflowCertificateShare).toHaveBeenCalledWith(
			'opaque-public-certificate-slug-123',
		)
		expect(
			mocks.checkSkillsWorkflowValuePathCertificateEligibility,
		).not.toHaveBeenCalled()
		expect(mocks.contentResourceFindFirst).not.toHaveBeenCalled()
		expect(mocks.userFindFirst).not.toHaveBeenCalled()
		expect(
			JSON.stringify(mocks.imageResponse.mock.calls[0]?.[0]),
		).not.toContain('contact-must-not-leak')
	})

	it('sets a safe filename only for the explicit download affordance', async () => {
		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?share=opaque-public-certificate-slug-123&download=1',
			),
		)

		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="joel-hooks-skills-workflow-certificate.png"',
		)
	})

	it('uses the shared course name in Crash Course downloads', async () => {
		mocks.getPublicSkillsWorkflowCertificateShare.mockResolvedValue({
			slug: 'opaque-crash-course-share-slug-123',
			resourceId: 'workshop-2ozd9',
			learnerName: 'Joel Hooks',
			courseName: 'AI Coding Crash Course',
			completedAt: new Date('2026-08-30T12:00:07.000Z'),
		})

		const response = await GET(
			new Request(
				'https://www.aihero.dev/api/certificates?share=opaque-crash-course-share-slug-123&download=1',
			),
		)

		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="joel-hooks-ai-coding-crash-course-certificate.png"',
		)
	})
})
