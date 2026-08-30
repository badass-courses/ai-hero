import type { CrashCourseCertificateEligibility } from './crash-course-certificate-eligibility'
import {
	ensureCertificateShare,
	type EnsureValuePathCertificateShareResult,
	type ValuePathCertificateShareRepository,
} from './subscriber-marketing/value-path-certificate-shares'

export const CRASH_COURSE_CERTIFICATE_COURSE_NAME =
	'AI Coding Crash Course' as const

export async function ensureCrashCourseCertificateShare(input: {
	eligibility: CrashCourseCertificateEligibility
	learnerName: string | null | undefined
	repository?: ValuePathCertificateShareRepository
	createSlug?: () => string
}): Promise<EnsureValuePathCertificateShareResult> {
	if (!input.eligibility.eligible) {
		return { available: false, reason: input.eligibility.reason }
	}
	const learnerName = input.learnerName?.trim()
	if (!learnerName) {
		return { available: false, reason: 'learner-name-missing' }
	}

	return ensureCertificateShare({
		ownerId: input.eligibility.userId,
		resourceId: input.eligibility.courseResourceId,
		learnerName,
		courseName: CRASH_COURSE_CERTIFICATE_COURSE_NAME,
		completedAt: input.eligibility.completedAt,
		repository: input.repository,
		createSlug: input.createSlug,
	})
}
