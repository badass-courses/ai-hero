import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	readCrashCourseCertificateGate: vi.fn(),
	isCrashCourseCertificateV1Enabled: vi.fn(),
	ensureCrashCourseCertificateShare: vi.fn(),
	getUserById: vi.fn(),
	buildCertificateShareUrl: vi.fn(),
	contentResourceFindFirst: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: { getUserById: mocks.getUserById },
}))
vi.mock('@/lib/crash-course-certificate-gate', () => ({
	readCrashCourseCertificateGate: mocks.readCrashCourseCertificateGate,
	isCrashCourseCertificateV1Enabled: mocks.isCrashCourseCertificateV1Enabled,
}))
vi.mock('@/lib/crash-course-certificate-eligibility', () => ({
	AI_CODING_CRASH_COURSE_FINAL_QUIZ: {
		courseResourceId: 'workshop-2ozd9',
	},
}))
vi.mock('@/lib/crash-course-certificate-shares', () => ({
	ensureCrashCourseCertificateShare: mocks.ensureCrashCourseCertificateShare,
}))
vi.mock('@/lib/subscriber-marketing/value-path-certificate-shares', () => ({
	buildCertificateShareUrl: mocks.buildCertificateShareUrl,
}))
vi.mock('@/server/auth', () => ({ getServerAuthSession: vi.fn() }))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/utils/cloudinary', () => ({
	cloudinary: { api: { resource: vi.fn() }, uploader: { upload: vi.fn() } },
}))

import { certificateRouter } from './certificate'

function caller(
	session: { user: { id: string } } | null = {
		user: { id: 'user-1' },
	},
) {
	return certificateRouter.createCaller({
		db: {
			query: {
				contentResource: {
					findFirst: mocks.contentResourceFindFirst,
				},
			},
		},
		session,
		ability: null,
		headers: new Headers(),
	} as any)
}

const granted = {
	status: 'granted' as const,
	eligibility: {
		eligible: true as const,
		userId: 'user-1',
		courseResourceId: 'workshop-2ozd9',
		finalQuizLessonId: 'sync_lesson_800b577c51997b78aa74a65c',
		completedAt: new Date('2026-08-30T12:00:07.000Z'),
		correctAnswers: 8,
		requiredAnswers: 8,
	},
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.isCrashCourseCertificateV1Enabled.mockReturnValue(true)
	mocks.buildCertificateShareUrl.mockReturnValue(
		'https://www.aihero.dev/certificates/opaque-crash-course-share-slug-123',
	)
})

describe('certificate router Crash Course gate', () => {
	it('rejects unauthenticated eligibility reads', async () => {
		await expect(caller(null).crashCourseEligibility()).rejects.toMatchObject({
			code: 'UNAUTHORIZED',
		})
		expect(mocks.readCrashCourseCertificateGate).not.toHaveBeenCalled()
	})

	it('creates an idempotent public permalink only after a granted gate', async () => {
		mocks.readCrashCourseCertificateGate.mockResolvedValue(granted)
		mocks.getUserById.mockResolvedValue({
			id: 'user-1',
			name: 'Joel Hooks',
			email: 'joel@example.com',
		})
		mocks.ensureCrashCourseCertificateShare.mockResolvedValue({
			available: true,
			created: true,
			share: {
				slug: 'opaque-crash-course-share-slug-123',
				resourceId: 'workshop-2ozd9',
				learnerName: 'Joel Hooks',
				courseName: 'AI Coding Crash Course',
				completedAt: granted.eligibility.completedAt,
			},
		})

		await expect(caller().ensureCrashCourseShare()).resolves.toMatchObject({
			available: true,
			created: true,
			permalink:
				'https://www.aihero.dev/certificates/opaque-crash-course-share-slug-123',
		})
		expect(mocks.readCrashCourseCertificateGate).toHaveBeenCalledWith({
			userId: 'user-1',
		})
		expect(mocks.ensureCrashCourseCertificateShare).toHaveBeenCalledWith({
			eligibility: granted.eligibility,
			learnerName: 'Joel Hooks',
		})
	})

	it('does not create a share while the learner is locked', async () => {
		mocks.readCrashCourseCertificateGate.mockResolvedValue({
			status: 'locked',
			reason: 'answers-incorrect',
			correctAnswers: 7,
			requiredAnswers: 8,
		})

		await expect(caller().ensureCrashCourseShare()).resolves.toEqual({
			available: false,
			reason: 'answers-incorrect',
		})
		expect(mocks.ensureCrashCourseCertificateShare).not.toHaveBeenCalled()
	})

	it('rejects caller-controlled image upload for the active Crash Course path', async () => {
		mocks.contentResourceFindFirst.mockResolvedValue({ id: 'workshop-2ozd9' })
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('must not fetch'))

		await expect(
			caller().upload({
				imagePath: 'https://attacker.example/fake.png',
				resourceIdOrSlug: 'ai-coding-crash-course',
			}),
		).resolves.toEqual({
			error: 'Crash Course certificates use the server-owned share path',
		})
		expect(fetchSpy).not.toHaveBeenCalled()
		fetchSpy.mockRestore()
	})
})
