import { signValuePathToken, type ValuePathTokenPayload } from './path-token'
import {
	SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG,
	type ValuePathAnswerPageResource,
} from './value-path-answer-page'

export type ValuePathAnswerLink = {
	answerPageId: string
	optionValue?: string
	href: string
}

export function buildValuePathAnswerLinks(args: {
	baseUrl: string
	secret: string
	tokenPayload: ValuePathTokenPayload
	answerPages: ValuePathAnswerPageResource[]
}): ValuePathAnswerLink[] {
	return [...args.answerPages]
		.sort(
			(left, right) =>
				(left.fields.position ?? Number.MAX_SAFE_INTEGER) -
				(right.fields.position ?? Number.MAX_SAFE_INTEGER),
		)
		.map((answerPage) => ({
		answerPageId: answerPage.id,
		optionValue: answerPage.fields.optionValue,
		href: buildValuePathAskUrl({
			baseUrl: args.baseUrl,
			secret: args.secret,
			slug: answerPage.fields.slug,
			optionValue:
				answerPage.fields.slug ===
				SHARED_SKILLS_WORKFLOW_CERTIFICATE_ANSWER_SLUG
					? answerPage.fields.optionValue
					: undefined,
			tokenPayload: args.tokenPayload,
			}),
		}))
}

export function buildValuePathAskUrl(args: {
	baseUrl: string
	secret: string
	slug: string
	optionValue?: string
	tokenPayload: ValuePathTokenPayload
}) {
	const url = new URL(
		`/ask/${encodeURIComponent(args.slug)}`,
		args.baseUrl.replace(/\/$/, ''),
	)
	if (args.optionValue) url.searchParams.set('answer', args.optionValue)
	url.searchParams.set(
		'pt',
		signValuePathToken({
			payload: args.tokenPayload,
			secret: args.secret,
		}),
	)
	return url.toString()
}
