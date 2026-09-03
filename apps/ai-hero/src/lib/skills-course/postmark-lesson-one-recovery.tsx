import { render } from '@react-email/render'
import { z } from 'zod'

import BasicEmail from '@/emails/basic-email'

import type {
	RecoveryProviderMessage,
	RecoveryProviderSendResult,
} from './support-lesson-one-recovery'
import type { buildSkillsCourseLessonOneEmail } from './lesson-one-email'

const POSTMARK_API_URL = 'https://api.postmarkapp.com'
const POSTMARK_TAG = 'skills-lesson-one-recovery'
const POSTMARK_RECOVERY_METADATA_KEY = 'recovery_key'

const postmarkMessageSchema = z.object({
	MessageID: z.string().min(1),
	Status: z.string().min(1),
	Recipients: z.array(z.string()).optional(),
	To: z.array(z.object({ Email: z.string() })).optional(),
	Metadata: z.record(z.string()).optional(),
})

const postmarkSearchSchema = z.object({
	Messages: z.array(postmarkMessageSchema),
})

const postmarkSendSchema = z.object({
	ErrorCode: z.number(),
	Message: z.string().optional(),
	MessageID: z.string().optional(),
})

export function createPostmarkSkillsLessonOneRecoveryProvider(args: {
	apiKey: string
	from: string
	replyTo: string
	fetch?: typeof fetch
}) {
	const fetchPostmark = args.fetch ?? fetch
	const headers = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
		'X-Postmark-Server-Token': args.apiKey,
	}

	return {
		async findByRecoveryKey({
			recipient,
			providerRecoveryKey,
		}: {
			recipient: string
			providerRecoveryKey: string
		}): Promise<RecoveryProviderMessage | null> {
			const url = new URL('/messages/outbound', POSTMARK_API_URL)
			url.searchParams.set('count', '10')
			url.searchParams.set('offset', '0')
			url.searchParams.set('recipient', recipient)
			url.searchParams.set('tag', POSTMARK_TAG)
			url.searchParams.set(
				`metadata_${POSTMARK_RECOVERY_METADATA_KEY}`,
				providerRecoveryKey,
			)
			const response = await fetchPostmark(url, { headers })
			if (!response.ok) {
				throw new Error(`Postmark search failed with HTTP ${response.status}`)
			}
			const parsed = postmarkSearchSchema.safeParse(await response.json())
			if (!parsed.success) throw new Error('Postmark search response was invalid')
			const matching = parsed.data.Messages.find(
				(message) =>
					message.Metadata?.[POSTMARK_RECOVERY_METADATA_KEY] ===
						providerRecoveryKey && messageRecipients(message).includes(recipient),
			)
			return matching ? toProviderMessage(matching) : null
		},

		async send({
			recipient,
			providerRecoveryKey,
			email,
		}: {
			recipient: string
			providerRecoveryKey: string
			email: ReturnType<typeof buildSkillsCourseLessonOneEmail>
		}): Promise<RecoveryProviderSendResult> {
			const htmlBody = await render(
				BasicEmail({
					preview: email.preview,
					messageType: 'transactional',
					body: email.body,
				}),
			)
			let response: Response
			try {
				response = await fetchPostmark(new URL('/email', POSTMARK_API_URL), {
					method: 'POST',
					headers,
					body: JSON.stringify({
						From: args.from,
						To: recipient,
						ReplyTo: args.replyTo,
						Subject: email.subject,
						HtmlBody: htmlBody,
						TextBody: email.body,
						MessageStream: 'outbound',
						Tag: POSTMARK_TAG,
						Metadata: {
							[POSTMARK_RECOVERY_METADATA_KEY]: providerRecoveryKey,
						},
					}),
				})
			} catch {
				return { state: 'ambiguous', reason: 'postmark-network-failure' }
			}

			let payload: unknown
			try {
				payload = await response.json()
			} catch {
				return { state: 'ambiguous', reason: 'postmark-response-invalid' }
			}
			const parsed = postmarkSendSchema.safeParse(payload)
			if (!parsed.success) {
				return { state: 'ambiguous', reason: 'postmark-response-invalid' }
			}
			if (!response.ok || parsed.data.ErrorCode !== 0) {
				const failureCode =
					parsed.data.ErrorCode !== 0
						? parsed.data.ErrorCode
						: response.status
				return {
					state: 'rejected',
					reason: `postmark-${failureCode}`,
					retryable: response.status === 429 || response.status >= 500,
				}
			}
			if (!parsed.data.MessageID) {
				return { state: 'ambiguous', reason: 'postmark-message-id-missing' }
			}
			return { state: 'accepted', messageId: parsed.data.MessageID }
		},

		async read(messageId: string): Promise<RecoveryProviderMessage | null> {
			const response = await fetchPostmark(
				new URL(
					`/messages/outbound/${encodeURIComponent(messageId)}/details`,
					POSTMARK_API_URL,
				),
				{ headers },
			)
			if (response.status === 404) return null
			if (!response.ok) {
				throw new Error(`Postmark readback failed with HTTP ${response.status}`)
			}
			const parsed = postmarkMessageSchema.safeParse(await response.json())
			if (!parsed.success) {
				throw new Error('Postmark readback response was invalid')
			}
			return toProviderMessage(parsed.data)
		},
	}
}

function messageRecipients(message: z.infer<typeof postmarkMessageSchema>) {
	return message.Recipients ?? message.To?.map((recipient) => recipient.Email) ?? []
}

function toProviderMessage(
	message: z.infer<typeof postmarkMessageSchema>,
): RecoveryProviderMessage {
	return {
		messageId: message.MessageID,
		status: message.Status,
		recipient: messageRecipients(message)[0] ?? '',
		providerRecoveryKey:
			message.Metadata?.[POSTMARK_RECOVERY_METADATA_KEY] ?? '',
	}
}
