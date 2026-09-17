import { z } from 'zod'

/**
 * The evergreen bridge and pitch on drovr: what ai-hero executes for the
 * `crash-course-evergreen-offer` journey once Joel enables it.
 *
 * Every message slot is one Kit sequence holding exactly one published
 * email; delivery is "add the subscriber to that sequence", the same
 * mechanism the skills course uses. The table below pins drovr's message
 * ids to the Kit sequences created for them (Kit names them with the
 * same ids). The rollout refuses to arm until a Kit readback shows all
 * eight sequences active with one email each, so an empty or draft
 * sequence can never be "sent".
 */

export const SEND_EVERGREEN_EMAIL_INTENT_TYPE = 'send-evergreen-email' as const

export type EvergreenSlot =
	| 'B1'
	| 'B2'
	| 'B3'
	| 'P1'
	| 'P2'
	| 'P3'
	| 'P4'
	| 'P5'

export type EvergreenKitSequence = {
	readonly slot: EvergreenSlot
	readonly messageId: string
	readonly sequenceId: number
}

/** Kit "AIH Crash Course Evergreen V3 <slot> <messageId>" sequences. */
export const EVERGREEN_KIT_SEQUENCES: readonly EvergreenKitSequence[] = [
	{ slot: 'B1', messageId: 'bridge_can_engineer_v1', sequenceId: 2887679 },
	{ slot: 'B2', messageId: 'bridge_real_codebase_v1', sequenceId: 2887680 },
	{ slot: 'B3', messageId: 'bridge_keep_skills_v1', sequenceId: 2887681 },
	{
		slot: 'P1',
		messageId: 'pitch_open_product_origin_v1',
		sequenceId: 2887682,
	},
	{
		slot: 'P2',
		messageId: 'pitch_watch_feature_build_v1',
		sequenceId: 2887683,
	},
	{ slot: 'P3', messageId: 'pitch_self_paced_faq_v1', sequenceId: 2887684 },
	{ slot: 'P4', messageId: 'pitch_proof_last_day_v1', sequenceId: 2887685 },
	{ slot: 'P5', messageId: 'pitch_final_notice_v1', sequenceId: 2887686 },
]

export function evergreenSequenceForMessage(
	messageId: string,
): EvergreenKitSequence | undefined {
	return EVERGREEN_KIT_SEQUENCES.find((entry) => entry.messageId === messageId)
}

export type DrovrEvergreenConfig = {
	readonly enabled: boolean
	/** Why it is off, for receipts; empty when enabled. */
	readonly reason?: string
}

/**
 * Off unless explicitly enabled AND drovr is reachable for the authority
 * tenant, for the same reason the ownership rollout is: accepting an
 * intent ai-hero cannot complete back to drovr strands the actor.
 */
export function parseDrovrEvergreenConfig(
	env: Readonly<Record<string, string | number | undefined>>,
): DrovrEvergreenConfig {
	const flag = String(env.AIH_DROVR_EVERGREEN_ENABLED ?? '')
		.trim()
		.toLowerCase()
	if (flag !== 'true' && flag !== '1') {
		return { enabled: false, reason: 'AIH_DROVR_EVERGREEN_ENABLED is not set' }
	}
	const present = (value: string | number | undefined) =>
		String(value ?? '').trim().length > 0
	if (
		!present(env.DROVR_SHADOW_INGEST_URL) ||
		!present(env.DROVR_API_KEY_ORG_AIHERO)
	) {
		return {
			enabled: false,
			reason: 'drovr ingest URL or authority tenant key is missing',
		}
	}
	return { enabled: true }
}

const sequenceReadback = z.object({
	sequence: z.object({
		id: z.number(),
		name: z.string(),
		active: z.boolean(),
		hold: z.boolean(),
		repeat: z.boolean(),
		email_count: z.number(),
	}),
})

export type EvergreenReadback = {
	readonly ready: boolean
	readonly problems: readonly string[]
	readonly checkedAt: string
}

/**
 * GET-only proof that each slot's sequence can deliver: active, not on
 * hold, not repeating, exactly one email. A sequence with zero emails is
 * the state Kit leaves a freshly created sequence in; adding a subscriber
 * to it would "send" nothing and the journey would move on.
 */
export async function readbackEvergreenSequences(options: {
	apiKey: string | undefined
	fetch: typeof fetch
	now?: () => string
	timeoutMs?: number
}): Promise<EvergreenReadback> {
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
	for (const entry of EVERGREEN_KIT_SEQUENCES) {
		const controller = new AbortController()
		const timer = setTimeout(
			() => controller.abort(),
			options.timeoutMs ?? 10_000,
		)
		try {
			const response = await options.fetch(
				`https://api.kit.com/v4/sequences/${entry.sequenceId}`,
				{
					headers: { 'X-Kit-Api-Key': apiKey },
					signal: controller.signal,
				},
			)
			if (response.status !== 200) {
				problems.push(`${entry.slot}: Kit answered ${response.status}`)
				continue
			}
			const parsed = sequenceReadback.safeParse(await response.json())
			if (!parsed.success) {
				problems.push(`${entry.slot}: unreadable sequence readback`)
				continue
			}
			const s = parsed.data.sequence
			if (s.id !== entry.sequenceId) {
				problems.push(`${entry.slot}: readback is for sequence ${s.id}`)
			}
			if (!s.name.includes(entry.messageId)) {
				problems.push(`${entry.slot}: sequence name lacks ${entry.messageId}`)
			}
			if (!s.active) problems.push(`${entry.slot}: sequence is not active`)
			if (s.hold) problems.push(`${entry.slot}: sequence is on hold`)
			if (s.repeat) problems.push(`${entry.slot}: sequence repeats`)
			if (s.email_count !== 1) {
				problems.push(`${entry.slot}: ${s.email_count} emails, expected 1`)
			}
		} catch (error) {
			problems.push(
				`${entry.slot}: ${error instanceof Error ? error.message : String(error)}`,
			)
		} finally {
			clearTimeout(timer)
		}
	}
	return { ready: problems.length === 0, problems, checkedAt }
}
