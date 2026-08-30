import {
	checkCrashCourseCertificateEligibility,
	type CrashCourseCertificateEligibility,
} from './crash-course-certificate-eligibility'

export const CRASH_COURSE_CERTIFICATE_V1_FLAG =
	'AIH_CRASH_COURSE_CERTIFICATE_V1_ENABLED' as const

export type CrashCourseCertificateGate =
	| { status: 'disabled' }
	| {
			status: 'granted'
			eligibility: Extract<
				CrashCourseCertificateEligibility,
				{ eligible: true }
			>
	  }
	| {
			status: 'locked'
			reason: 'answers-missing' | 'answers-incorrect'
			correctAnswers: number
			requiredAnswers: number
	  }
	| {
			status: 'unavailable'
			reason:
				| 'query-failed'
				| 'not-authenticated'
				| 'course-not-found'
				| 'final-quiz-not-configured'
				| 'final-quiz-empty'
				| 'final-quiz-question-set-mismatch'
	  }

export function isCrashCourseCertificateV1Enabled(
	value: string | undefined = process.env[CRASH_COURSE_CERTIFICATE_V1_FLAG],
) {
	return value === 'true'
}

export async function readCrashCourseCertificateGate(
	input: { userId: string },
	dependencies: {
		enabled?: boolean
		checkEligibility?: typeof checkCrashCourseCertificateEligibility
	} = {},
): Promise<CrashCourseCertificateGate> {
	const enabled = dependencies.enabled ?? isCrashCourseCertificateV1Enabled()
	if (!enabled) return { status: 'disabled' }
	try {
		const checkEligibility =
			dependencies.checkEligibility ?? checkCrashCourseCertificateEligibility
		return decideCrashCourseCertificateGate({
			enabled,
			eligibility: await checkEligibility({ userId: input.userId }),
		})
	} catch {
		return decideCrashCourseCertificateGate({
			enabled,
			queryFailed: true,
		})
	}
}

export function decideCrashCourseCertificateGate(input: {
	enabled: boolean
	eligibility?: CrashCourseCertificateEligibility
	queryFailed?: boolean
}): CrashCourseCertificateGate {
	if (!input.enabled) return { status: 'disabled' }
	if (input.queryFailed || !input.eligibility) {
		return { status: 'unavailable', reason: 'query-failed' }
	}
	if (input.eligibility.eligible) {
		return { status: 'granted', eligibility: input.eligibility }
	}
	if (
		input.eligibility.reason === 'answers-missing' ||
		input.eligibility.reason === 'answers-incorrect'
	) {
		return {
			status: 'locked',
			reason: input.eligibility.reason,
			correctAnswers: input.eligibility.correctAnswers,
			requiredAnswers: input.eligibility.requiredAnswers,
		}
	}
	return { status: 'unavailable', reason: input.eligibility.reason }
}
