import BasicEmail from '@/emails/basic-email'

import { render } from '@react-email/render'

const POSTMARK_EMAIL_URL = 'https://api.postmarkapp.com/email'
const POSTMARK_OUTBOUND_URL = 'https://api.postmarkapp.com/messages/outbound'
const RECOVERY_METADATA_KEY = 'recovery_request_id'
const RECOVERY_TAG = 'skills-course-lesson-one-recovery'

export type RecoveryDeliveryReadback =
	| { found: true; messageId: string }
	| { found: false }

export async function readSkillsCourseRecoveryDelivery(args: {
	correlationId: string
	postmarkToken: string
	fetchImpl?: typeof fetch
}): Promise<RecoveryDeliveryReadback> {
	const url = new URL(POSTMARK_OUTBOUND_URL)
	url.searchParams.set('count', '1')
	url.searchParams.set('offset', '0')
	url.searchParams.set(`metadata_${RECOVERY_METADATA_KEY}`, args.correlationId)
	const response = await (args.fetchImpl ?? fetch)(url, {
		method: 'GET',
		headers: postmarkHeaders(args.postmarkToken),
	})
	if (!response.ok) throw new Error('Postmark recovery readback failed')
	const body: unknown = await response.json()
	const messageId = firstMessageId(body)
	return messageId ? { found: true, messageId } : { found: false }
}

export async function sendSkillsCourseRecoveryDelivery(args: {
	correlationId: string
	to: string
	subject: string
	body: string
	preview: string
	from: string
	replyTo: string
	postmarkToken: string
	fetchImpl?: typeof fetch
}) {
	const HtmlBody = await render(
		BasicEmail({
			preview: args.preview,
			messageType: 'transactional',
			body: args.body,
		}),
	)
	const response = await (args.fetchImpl ?? fetch)(POSTMARK_EMAIL_URL, {
		method: 'POST',
		headers: postmarkHeaders(args.postmarkToken),
		body: JSON.stringify({
			From: args.from,
			To: args.to,
			Subject: args.subject,
			ReplyTo: args.replyTo,
			HtmlBody,
			MessageStream: 'outbound',
			Tag: RECOVERY_TAG,
			Metadata: { [RECOVERY_METADATA_KEY]: args.correlationId },
		}),
	})
	if (!response.ok) throw new Error('Postmark recovery delivery failed')
	const body: unknown = await response.json()
	const messageId = successfulMessageId(body)
	if (!messageId) throw new Error('Postmark recovery delivery failed')
	return { messageId }
}

function postmarkHeaders(token: string) {
	if (!token) throw new Error('Postmark recovery delivery is unavailable')
	return {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		'X-Postmark-Server-Token': token,
	}
}

function firstMessageId(value: unknown) {
	if (!value || typeof value !== 'object' || !('Messages' in value)) {
		return undefined
	}
	const messages = value.Messages
	if (!Array.isArray(messages)) return undefined
	const first: unknown = messages[0]
	return messageId(first)
}

function successfulMessageId(value: unknown) {
	if (!value || typeof value !== 'object') return undefined
	if (
		'ErrorCode' in value &&
		(typeof value.ErrorCode !== 'number' || value.ErrorCode !== 0)
	) {
		return undefined
	}
	return messageId(value)
}

function messageId(value: unknown) {
	return value &&
		typeof value === 'object' &&
		'MessageID' in value &&
		typeof value.MessageID === 'string' &&
		value.MessageID.length > 0
		? value.MessageID
		: undefined
}
