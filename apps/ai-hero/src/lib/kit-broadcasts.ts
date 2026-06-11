import { z } from 'zod'

const KIT_BASE = 'https://api.kit.com/v4'

export const AI_HERO_SKILLS_TEMPLATE_ID = 5176054
export const AI_HERO_SKILLS_FROM_ADDRESS = 'matt@aihero.dev'
export const AI_HERO_SKILLS_EXCLUSION_TAG_IDS = [19251081, 8244351] as const

export const AiHeroSkillsSubscriberFilter = [
	{
		none: [
			{
				type: 'tag',
				ids: [...AI_HERO_SKILLS_EXCLUSION_TAG_IDS],
			},
		],
	},
] as const

const KitBroadcastSchema = z.object({
	id: z.number(),
	publication_id: z.number().optional().nullable(),
	subject: z.string().optional().nullable(),
	preview_text: z.string().optional().nullable(),
	description: z.string().optional().nullable(),
	email_address: z.string().optional().nullable(),
	email_template: z
		.object({
			id: z.number(),
			name: z.string().optional().nullable(),
		})
		.optional()
		.nullable(),
	subscriber_filter: z.unknown().optional().nullable(),
	send_at: z.string().optional().nullable(),
	public: z.boolean().optional().nullable(),
})

const KitCreateBroadcastResponseSchema = z.object({
	broadcast: KitBroadcastSchema,
})

export type KitBroadcast = z.infer<typeof KitBroadcastSchema>

function getKitApiKey() {
	const key = process.env.CONVERTKIT_V4_API_KEY
	if (!key) throw new Error('CONVERTKIT_V4_API_KEY is required')
	return key
}

function normalizeKitContent(content: string) {
	if (/<[a-z][\s\S]*>/i.test(content)) return content

	return content
		.split(/\n{2,}/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br />')}</p>`)
		.join('\n')
}

export async function createAiHeroSkillsBroadcast(input: {
	subject: string
	content: string
	previewText?: string | null
	description?: string | null
}) {
	const response = await fetch(`${KIT_BASE}/broadcasts`, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'X-Kit-Api-Key': getKitApiKey(),
		},
		body: JSON.stringify({
			subject: input.subject,
			content: normalizeKitContent(input.content),
			public: false,
			send_at: null,
			email_template_id: AI_HERO_SKILLS_TEMPLATE_ID,
			email_address: AI_HERO_SKILLS_FROM_ADDRESS,
			subscriber_filter: AiHeroSkillsSubscriberFilter,
			...(input.previewText && { preview_text: input.previewText }),
			...(input.description && { description: input.description }),
		}),
	})

	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`Kit API returned ${response.status}: ${errorText}`)
	}

	const parsed = KitCreateBroadcastResponseSchema.safeParse(
		await response.json(),
	)
	if (!parsed.success) {
		throw new Error(
			`Kit broadcast response parse failed: ${parsed.error.message}`,
		)
	}

	return parsed.data.broadcast
}

export class KitBroadcastSentError extends Error {
	constructor(public broadcastId: number | string) {
		super(
			`Kit broadcast ${broadcastId} has already been sent and cannot be updated.`,
		)
		this.name = 'KitBroadcastSentError'
	}
}

export async function updateAiHeroSkillsBroadcast(
	broadcastId: number | string,
	input: {
		subject: string
		content: string
		previewText?: string | null
		description?: string | null
	},
) {
	const response = await fetch(`${KIT_BASE}/broadcasts/${broadcastId}`, {
		method: 'PUT',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
			'X-Kit-Api-Key': getKitApiKey(),
		},
		body: JSON.stringify({
			subject: input.subject,
			content: normalizeKitContent(input.content),
			email_template_id: AI_HERO_SKILLS_TEMPLATE_ID,
			email_address: AI_HERO_SKILLS_FROM_ADDRESS,
			subscriber_filter: AiHeroSkillsSubscriberFilter,
			...(input.previewText && { preview_text: input.previewText }),
			...(input.description && { description: input.description }),
		}),
	})

	if (response.status === 422 || response.status === 409) {
		throw new KitBroadcastSentError(broadcastId)
	}

	if (!response.ok) {
		const errorText = await response.text()
		throw new Error(`Kit API returned ${response.status}: ${errorText}`)
	}

	const parsed = KitCreateBroadcastResponseSchema.safeParse(
		await response.json(),
	)
	if (!parsed.success) {
		throw new Error(
			`Kit broadcast update response parse failed: ${parsed.error.message}`,
		)
	}

	return parsed.data.broadcast
}
