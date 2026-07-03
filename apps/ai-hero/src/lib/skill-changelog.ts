import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas/content-resource-schema'

import { PostStateSchema, PostTagsSchema, PostVisibilitySchema } from './posts'

export const SkillChangelogFieldsSchema = z.object({
	title: z.string(),
	slug: z.string(),
	body: z.string().nullable().optional(),
	description: z.string().nullish(),
	state: PostStateSchema.default('draft'),
	visibility: PostVisibilitySchema.default('unlisted'),
	github: z.string().nullish(),
	thumbnailTime: z.number().nullish(),
	coverImage: z
		.object({
			url: z.string().url().or(z.literal('')),
			alt: z.string().optional(),
		})
		.nullish(),
	newsletterSubject: z.string().nullish(),
	newsletterPreviewText: z.string().nullish(),
	newsletterCopy: z.string().nullish(),
	kitBroadcastId: z.union([z.string(), z.number()]).nullish(),
	kitBroadcastPublicationId: z.union([z.string(), z.number()]).nullish(),
	kitBroadcastCreatedAt: z.string().nullish(),
	kitBroadcastUpdatedAt: z.string().nullish(),
	kitBroadcastTemplateId: z.union([z.string(), z.number()]).nullish(),
	kitBroadcastFromAddress: z.string().nullish(),
	kitBroadcastExclusionTagIds: z.array(z.number()).nullish(),
})

export const SkillChangelogSchema = ContentResourceSchema.merge(
	z.object({
		fields: SkillChangelogFieldsSchema,
		tags: PostTagsSchema,
	}),
)

export type SkillChangelog = z.infer<typeof SkillChangelogSchema>

export const SkillChangelogUpdateSchema = z.object({
	id: z.string(),
	fields: z.object({
		title: z.string().min(2).max(120),
		slug: z.string(),
		body: z.string().optional().nullable(),
		description: z.string().nullish(),
		state: PostStateSchema.optional(),
		visibility: PostVisibilitySchema.optional(),
		github: z.string().nullish(),
		thumbnailTime: z.number().nullish(),
		coverImage: z
			.object({
				url: z.string().url().or(z.literal('')),
				alt: z.string().optional(),
			})
			.nullish(),
		newsletterSubject: z.string().nullish(),
		newsletterPreviewText: z.string().nullish(),
		newsletterCopy: z.string().nullish(),
	}),
})

export type SkillChangelogUpdate = z.infer<typeof SkillChangelogUpdateSchema>

export type SkillChangelogAction = 'save' | 'publish' | 'unpublish' | 'archive'
