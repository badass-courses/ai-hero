import type { FixtureContactEventInput, PrivacyLevel, Provider } from './types'

export type FrontQuickQuestionInput = {
	conversationId: string
	messageId?: string
	messageCreatedAt: string
	text: string
	senderEmail?: string
	senderName?: string
	frontContactId?: string
	recipientHandle?: string
	isFollowUp?: boolean
	privacyLevel?: PrivacyLevel
}

export type QuickQuestionCaptureInput = FrontQuickQuestionInput & {
	provider?: Extract<Provider, 'front'>
}

export function normalizeFrontQuickQuestionInput(
	input: QuickQuestionCaptureInput,
): FixtureContactEventInput {
	const text = cleanReplyText(input.text)
	const normalizedText = normalizeTextForKey(text)
	const messageKey = input.messageId ?? stableTextKey(normalizedText)
	const externalId =
		input.frontContactId ??
		input.senderEmail?.trim().toLowerCase() ??
		messageKey

	return {
		provider: 'front',
		providerEventId: `${input.conversationId}:${messageKey}`,
		eventType: input.isFollowUp
			? 'quick-question.follow-up-reply'
			: 'quick-question.reply',
		occurredAt: input.messageCreatedAt,
		email: input.senderEmail,
		name: input.senderName,
		externalId,
		message: text,
		privacyLevel: input.privacyLevel ?? 'internal',
	}
}

function cleanReplyText(text: string) {
	let cleaned = text.replace(/\r/g, '').trim()
	for (const marker of [
		'\nOn Mon,',
		'\nOn Tue,',
		'\nOn Wed,',
		'\nOn Thu,',
		'\nOn Fri,',
		'\nOn Sat,',
		'\nOn Sun,',
		'\n--- original message ---',
		'To unsubscribe from AI Hero',
		'Unsubscribe from AI Hero',
	]) {
		const index = cleaned.indexOf(marker)
		if (index !== -1) cleaned = cleaned.slice(0, index)
	}
	return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

function normalizeTextForKey(text: string) {
	return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

function stableTextKey(text: string) {
	let hash = 0
	for (let index = 0; index < text.length; index++) {
		hash = (hash * 31 + text.charCodeAt(index)) >>> 0
	}
	return `text-${hash.toString(16)}`
}
