import 'server-only'

import { cookies } from 'next/headers'

import {
	SKILLS_COURSE_RECOVERY_TOKEN_COOKIE,
	SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS,
	signSkillsCourseRecoveryToken,
	verifySkillsCourseRecoveryToken,
} from './skills-course-recovery-token'

export async function issueSkillsCourseRecoveryToken(args: {
	kitSubscriberId: string
	email: string
}) {
	const secret = recoveryTokenSecret()
	const token = signSkillsCourseRecoveryToken({ ...args, secret })
	const cookieStore = await cookies()
	cookieStore.set(SKILLS_COURSE_RECOVERY_TOKEN_COOKIE, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		path: '/',
		maxAge: SKILLS_COURSE_RECOVERY_TOKEN_TTL_MS / 1000,
	})
}

export async function readSkillsCourseRecoveryToken() {
	const cookieStore = await cookies()
	return verifySkillsCourseRecoveryToken({
		token: cookieStore.get(SKILLS_COURSE_RECOVERY_TOKEN_COOKIE)?.value,
		secret: recoveryTokenSecret(),
	})
}

function recoveryTokenSecret() {
	const secret =
		process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET ??
		(process.env.NODE_ENV === 'production'
			? undefined
			: 'dev-value-path-token-secret')
	if (!secret) throw new Error('Skills course recovery token is unavailable')
	return secret
}
