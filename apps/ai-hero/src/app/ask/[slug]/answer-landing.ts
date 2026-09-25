import { log } from '@/server/logger'
import { verifyValuePathToken } from '@/lib/subscriber-marketing/path-token'
import {
	getValuePathAnswerPageBySlug,
	SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG,
} from '@/lib/subscriber-marketing/value-path-answer-page'

/**
 * Read-only: verify the link's path token and find its answer page. Both the
 * GET landing (which records nothing) and the confirm POST start here.
 */
export async function resolveAnswerLanding(input: {
	slug: string
	pt?: string
	answer?: string
}) {
	const token = verifyValuePathToken({
		token: input.pt,
		secret: getPathTokenSecret(),
		expirationPolicy:
			input.slug === SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG
				? 'allow-expired'
				: 'enforce',
	})
	const answerPage = await getValuePathAnswerPageBySlug({
		slug: input.slug,
		optionValue: input.answer,
		sequenceId: token.valid ? token.payload.sequenceId : undefined,
		emailId: token.valid
			? emailIdFromResourceId(token.payload.emailResourceId)
			: undefined,
	})
	if (answerPage && !token.valid) {
		await log.warn('value-path.ask.token_invalid', {
			slug: input.slug,
			reason: token.reason,
			hasToken: Boolean(input.pt),
		})
	}
	return { token, answerPage }
}

export type AnswerPage = NonNullable<
	Awaited<ReturnType<typeof resolveAnswerLanding>>['answerPage']
>

export function isCertificateAnswer(answerPage: AnswerPage) {
	return (
		answerPage.fields.emailId === 'email-7' ||
		answerPage.fields.emailId === 'team-email-7'
	)
}

/** The landing URL, carrying the link's own pt and answer. */
export function answerLandingPath(input: {
	slug: string
	pt?: string
	answer?: string
	confirmed?: boolean
}) {
	const params = new URLSearchParams()
	if (input.answer) params.set('answer', input.answer)
	if (input.pt) params.set('pt', input.pt)
	if (input.confirmed) params.set('confirmed', '1')
	const query = params.toString()
	return `/ask/${encodeURIComponent(input.slug)}${query ? `?${query}` : ''}`
}

export function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

function emailIdFromResourceId(resourceId: string) {
	const [, emailId] = resourceId.split(/\.(.+)/)
	return emailId
}

function getPathTokenSecret() {
	return (
		process.env.AI_HERO_VALUE_PATH_TOKEN_SECRET ?? 'dev-value-path-token-secret'
	)
}
