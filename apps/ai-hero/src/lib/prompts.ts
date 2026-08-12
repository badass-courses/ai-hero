import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas/content-resource-schema'

export const NewPromptSchema = z.object({
	fields: z.object({
		title: z.string().min(2).max(90),
	}),
})
export type NewPrompt = z.infer<typeof NewPromptSchema>

export const PromptStateSchema = z.union([
	z.literal('draft'),
	z.literal('published'),
	z.literal('archived'),
	z.literal('deleted'),
])

export const PromptVisibilitySchema = z.union([
	z.literal('public'),
	z.literal('private'),
	z.literal('unlisted'),
])

export const PromptEventSchema = z.object({
	title: z.string().min(2),
	description: z.string().optional().nullable(),
	startsAt: z.string().datetime(),
	endsAt: z.string().datetime(),
	timezone: z.string().min(1),
	watchUrl: z.string().url(),
	humanCalendarUrl: z.string().url(),
	agentCalendarUrl: z.string().url(),
})

export const PromptSchema = ContentResourceSchema.merge(
	z.object({
		fields: z.object({
			title: z.string().min(2).max(90),
			body: z.string().optional().nullable(),
			description: z.string().optional().nullable(),
			slug: z.string(),
			state: PromptStateSchema.default('draft'),
			visibility: PromptVisibilitySchema.default('unlisted'),
			// Server-owned publish stamp — see publishedAtStamp in
			// @coursebuilder/ui/cms/resource-state.
			publishedAt: z.string().datetime().nullish(),
			model: z.string().default('gpt-4o'),
			provider: z.string().default('openai'),
			event: PromptEventSchema.optional().nullable(),
			agentInstructions: z.array(z.string().min(1)).optional().nullable(),
		}),
	}),
)

export type Prompt = z.infer<typeof PromptSchema>

export function isPromptPubliclyViewable(prompt: Prompt) {
	return (
		prompt.fields.state === 'published' &&
		(prompt.fields.visibility === 'public' ||
			prompt.fields.visibility === 'unlisted')
	)
}
