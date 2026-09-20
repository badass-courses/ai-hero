import { z } from 'zod'

/**
 * The pinned drovr shadow-newsletter catalog projection. The catalog itself
 * owns message order and revision; ai-hero owns the provider ids so the
 * drovr journey never learns Kit details.
 */
export const SHADOW_NEWSLETTER_JOURNEY_ID = 'shadow-newsletter' as const
export const SHADOW_NEWSLETTER_LIST = 'shadow-newsletter' as const
export const SHADOW_NEWSLETTER_CATALOG_REVISION =
	'kit-2625552-2026-09-19' as const
export const SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE =
	'send-shadow-newsletter-email' as const

export type ShadowNewsletterKitSequence = {
	readonly messageId: string
	readonly position: number
	readonly sequenceId: number
}

/** Kit sequence ids read back after the stage 2a loader applied. */
export const SHADOW_NEWSLETTER_KIT_SEQUENCES = [
	{
		messageId: 'agents_md_big_problem_v1',
		position: 0,
		sequenceId: 2_899_143,
	},
	{
		messageId: 'skill_claude_tdd_v1',
		position: 3,
		sequenceId: 2_899_144,
	},
	{
		messageId: 'ai_feedback_loops_v1',
		position: 4,
		sequenceId: 2_899_145,
	},
	{
		messageId: 'classic_technique_with_ai_v1',
		position: 5,
		sequenceId: 2_899_146,
	},
	{
		messageId: 'how_llm_tokens_work_v1',
		position: 7,
		sequenceId: 2_899_147,
	},
	{
		messageId: 'hook_dangerous_git_v1',
		position: 8,
		sequenceId: 2_899_148,
	},
	{
		messageId: 'codebases_claude_loves_v1',
		position: 9,
		sequenceId: 2_899_149,
	},
	{
		messageId: 'viral_talk_v1',
		position: 10,
		sequenceId: 2_899_150,
	},
	{
		messageId: 'triage_backlog_v1',
		position: 11,
		sequenceId: 2_899_151,
	},
	{
		messageId: 'grill_me_replacement_v1',
		position: 12,
		sequenceId: 2_899_152,
	},
] as const satisfies readonly ShadowNewsletterKitSequence[]

export const ShadowNewsletterSendPayload = z.object({
	newsletter: z.literal(SHADOW_NEWSLETTER_LIST),
	catalogRevision: z.string().min(1),
	messageId: z.string().min(1),
	position: z.number().int().nonnegative().optional(),
})

export type ShadowNewsletterSendPayload = z.infer<
	typeof ShadowNewsletterSendPayload
>

/** Resolve only the exact catalog revision the executor was built for. */
export function shadowNewsletterSequenceForMessage(
	catalogRevision: string,
	messageId: string,
): ShadowNewsletterKitSequence | undefined {
	if (catalogRevision !== SHADOW_NEWSLETTER_CATALOG_REVISION) return undefined
	return SHADOW_NEWSLETTER_KIT_SEQUENCES.find(
		(entry) => entry.messageId === messageId,
	)
}

/**
 * Readback gate for the ten one-email sequences. The executor can accept an
 * intent before the cron runs, but the sender must not touch Kit until every
 * mapped sequence is active, released, non-repeating, and has one published
 * email.
 */
export type ShadowNewsletterReadback = {
	readonly ready: boolean
	readonly problems: readonly string[]
	readonly checkedAt: string
}

const sequenceReadback = z.object({
	sequence: z.object({
		id: z.number(),
		active: z.boolean(),
		hold: z.boolean(),
		repeat: z.boolean(),
		email_count: z.number(),
	}),
})

const sequenceEmailsReadback = z.object({
	emails: z.array(z.object({ id: z.number(), published: z.boolean() })),
})

export async function readbackShadowNewsletterSequences(options: {
	apiKey: string | undefined
	fetch: typeof fetch
	now?: () => string
	timeoutMs?: number
}): Promise<ShadowNewsletterReadback> {
	const checkedAt = (options.now ?? (() => new Date().toISOString()))()
	const apiKey = options.apiKey?.trim()
	if (!apiKey) {
		return {
			ready: false,
			problems: ['Kit v4 API key is not configured'],
			checkedAt,
		}
	}
	const problems: string[] = []
	const get = async (path: string) => {
		const controller = new AbortController()
		const timer = setTimeout(
			() => controller.abort(),
			options.timeoutMs ?? 10_000,
		)
		try {
			return await options.fetch(`https://api.kit.com/v4${path}`, {
				headers: { 'X-Kit-Api-Key': apiKey },
				signal: controller.signal,
			})
		} finally {
			clearTimeout(timer)
		}
	}
	for (const entry of SHADOW_NEWSLETTER_KIT_SEQUENCES) {
		try {
			const response = await get(`/sequences/${entry.sequenceId}`)
			if (response.status !== 200) {
				problems.push(`${entry.messageId}: Kit answered ${response.status}`)
				continue
			}
			const parsed = sequenceReadback.safeParse(await response.json())
			if (!parsed.success) {
				problems.push(`${entry.messageId}: unreadable sequence readback`)
				continue
			}
			const sequence = parsed.data.sequence
			if (sequence.id !== entry.sequenceId) {
				problems.push(
					`${entry.messageId}: readback is for sequence ${sequence.id}`,
				)
			}
			if (!sequence.active) {
				problems.push(`${entry.messageId}: sequence is not active`)
			}
			if (sequence.hold) {
				problems.push(`${entry.messageId}: sequence is on hold`)
			}
			if (sequence.repeat) {
				problems.push(`${entry.messageId}: sequence repeats`)
			}
			if (sequence.email_count !== 1) {
				problems.push(
					`${entry.messageId}: ${sequence.email_count} emails, expected 1`,
				)
				continue
			}
			const emailsResponse = await get(`/sequences/${entry.sequenceId}/emails`)
			if (emailsResponse.status !== 200) {
				problems.push(
					`${entry.messageId}: Kit answered ${emailsResponse.status} for emails`,
				)
				continue
			}
			const emails = sequenceEmailsReadback.safeParse(
				await emailsResponse.json(),
			)
			if (!emails.success) {
				problems.push(`${entry.messageId}: unreadable sequence emails readback`)
				continue
			}
			const published = emails.data.emails.filter((email) => email.published)
			if (emails.data.emails.length !== 1 || published.length !== 1) {
				problems.push(
					`${entry.messageId}: ${published.length} published of ${emails.data.emails.length} emails, expected 1 of 1`,
				)
			}
		} catch (error) {
			problems.push(
				`${entry.messageId}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	return { ready: problems.length === 0, problems, checkedAt }
}
