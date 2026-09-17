import { createHmac, timingSafeEqual } from 'node:crypto'

export const SKILLS_COURSE_RECOVERY_TOKEN_COOKIE =
	'aih_skills_course_recovery' as const
export const SKILLS_COURSE_RECOVERY_TOKEN_PURPOSE =
	'skills-course-lesson-one-recovery' as const
export const SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000

type SkillsCourseRecoveryTokenPayload = {
	version: 1
	purpose: typeof SKILLS_COURSE_RECOVERY_TOKEN_PURPOSE
	kitSubscriberId: string
	email: string
	issuedAt: string
	expiresAt: string
}

export type SkillsCourseRecoveryTokenVerification =
	| { valid: true; payload: SkillsCourseRecoveryTokenPayload }
	| {
			valid: false
			reason: 'missing' | 'malformed' | 'tampered' | 'expired'
	  }

export function signSkillsCourseRecoveryToken(args: {
	kitSubscriberId: string
	email: string
	secret: string
	now?: Date
}) {
	const now = args.now ?? new Date()
	const payload: SkillsCourseRecoveryTokenPayload = {
		version: 1,
		purpose: SKILLS_COURSE_RECOVERY_TOKEN_PURPOSE,
		kitSubscriberId: args.kitSubscriberId,
		email: normalizeEmail(args.email),
		issuedAt: now.toISOString(),
		expiresAt: new Date(
			now.getTime() + SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS,
		).toISOString(),
	}
	const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
		'base64url',
	)
	return `${encodedPayload}.${signature(encodedPayload, args.secret)}`
}

export function verifySkillsCourseRecoveryToken(args: {
	token?: string | null
	secret: string
	now?: Date
}): SkillsCourseRecoveryTokenVerification {
	if (!args.token) return { valid: false, reason: 'missing' }
	const [encodedPayload, suppliedSignature, extra] = args.token.split('.')
	if (!encodedPayload || !suppliedSignature || extra) {
		return { valid: false, reason: 'malformed' }
	}
	if (
		!constantTimeEqual(
			suppliedSignature,
			signature(encodedPayload, args.secret),
		)
	) {
		return { valid: false, reason: 'tampered' }
	}

	try {
		const payload: unknown = JSON.parse(
			Buffer.from(encodedPayload, 'base64url').toString('utf8'),
		)
		if (!isSkillsCourseRecoveryTokenPayload(payload)) {
			return { valid: false, reason: 'malformed' }
		}
		const issuedAt = new Date(payload.issuedAt).getTime()
		const expiresAt = new Date(payload.expiresAt).getTime()
		if (
			!Number.isFinite(issuedAt) ||
			!Number.isFinite(expiresAt) ||
			expiresAt - issuedAt !== SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS
		) {
			return { valid: false, reason: 'malformed' }
		}
		if (expiresAt <= (args.now ?? new Date()).getTime()) {
			return { valid: false, reason: 'expired' }
		}
		return { valid: true, payload }
	} catch {
		return { valid: false, reason: 'malformed' }
	}
}

export function normalizeSkillsCourseRecoveryEmail(value: string) {
	return normalizeEmail(value)
}

function signature(encodedPayload: string, secret: string) {
	return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

function constantTimeEqual(left: string, right: string) {
	const leftBuffer = Buffer.from(left)
	const rightBuffer = Buffer.from(right)
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	)
}

function normalizeEmail(value: string) {
	return value.trim().toLowerCase()
}

function isSkillsCourseRecoveryTokenPayload(
	value: unknown,
): value is SkillsCourseRecoveryTokenPayload {
	if (!value || typeof value !== 'object') return false
	return (
		'version' in value &&
		value.version === 1 &&
		'purpose' in value &&
		value.purpose === SKILLS_COURSE_RECOVERY_TOKEN_PURPOSE &&
		'kitSubscriberId' in value &&
		typeof value.kitSubscriberId === 'string' &&
		value.kitSubscriberId.length > 0 &&
		'email' in value &&
		typeof value.email === 'string' &&
		value.email === normalizeEmail(value.email) &&
		value.email.length > 0 &&
		'issuedAt' in value &&
		typeof value.issuedAt === 'string' &&
		'expiresAt' in value &&
		typeof value.expiresAt === 'string'
	)
}
