import * as z from 'zod'

import { TagSchema } from './tags'

export const TypesenseResourceSchema = z.object({
	id: z.string(),
	title: z.string(),
	slug: z.string(),
	state: z.string(),
	description: z.string().optional(),
	summary: z.string().optional(),
	image: z.string().optional(),
	visibility: z.string(),
	type: z.string(),
	published_at_timestamp: z.number().optional(),
	updated_at_timestamp: z.number().optional(),
	created_at_timestamp: z.number().optional(),
	popularity_30d: z.number().int().nonnegative().optional(),
	// Video facts — derived from the resource graph (see `video-facts.ts`),
	// never hand-set. Written by both index paths and the hourly reconcile.
	has_video: z.boolean().optional(),
	free: z.boolean().optional(),
	course_ids: z.array(z.string()).nullish(),
	duration_seconds: z.number().int().nonnegative().nullish(),
	container_title: z.string().nullish(),
	mux_playback_id: z.string().nullish(),
	thumbnail_time: z.number().int().nonnegative().nullish(),
	tags: z.array(TagSchema).nullish(),
	parentResources: z
		.array(
			z.object({
				id: z.string(),
				title: z.string(),
				slug: z.string(),
				type: z.string(),
				visibility: z.string(),
				state: z.string(),
			}),
		)
		.nullish(),
})

export const attributeLabelMap: {
	[K in keyof z.infer<typeof TypesenseResourceSchema>]: string
} = {
	description: 'Description',
	summary: 'Summary',
	image: 'Image',
	title: 'Title',
	type: 'Type',
	state: 'State',
	visibility: 'Visibility',
	id: 'ID',
	slug: 'Slug',
	published_at_timestamp: 'Published At',
	updated_at_timestamp: 'Updated At',
	created_at_timestamp: 'Created At',
	popularity_30d: 'Popularity (30d)',
	has_video: 'Has Video',
	free: 'Free',
	course_ids: 'Course IDs',
	duration_seconds: 'Duration (s)',
	container_title: 'Container Title',
	mux_playback_id: 'Mux Playback ID',
	thumbnail_time: 'Thumbnail Time',
	tags: 'Tags',
	parentResources: 'Parent Resources',
} as const

export type TypesenseResource = z.infer<typeof TypesenseResourceSchema>
