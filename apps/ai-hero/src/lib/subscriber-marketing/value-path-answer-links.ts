import { signValuePathToken, type ValuePathTokenPayload } from './path-token'
import type { ValuePathAnswerPageResource } from './value-path-answer-page'

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
	return args.answerPages.map((answerPage) => ({
		answerPageId: answerPage.id,
		optionValue: answerPage.fields.optionValue,
		href: buildValuePathAskUrl({
			baseUrl: args.baseUrl,
			secret: args.secret,
			slug: answerPage.fields.slug,
			tokenPayload: args.tokenPayload,
		}),
	}))
}

export function buildValuePathAskUrl(args: {
	baseUrl: string
	secret: string
	slug: string
	tokenPayload: ValuePathTokenPayload
}) {
	const baseUrl = args.baseUrl.replace(/\/$/, '')
	const token = signValuePathToken({
		payload: args.tokenPayload,
		secret: args.secret,
	})
	return `${baseUrl}/ask/${encodeURIComponent(args.slug)}?pt=${encodeURIComponent(token)}`
}
