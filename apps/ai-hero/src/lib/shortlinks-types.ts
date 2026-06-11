import { shortlink, shortlinkClick } from '@/db/schema'
import { z } from 'zod'

const shortlinkMetadataSlug = z
	.string()
	.min(1)
	.max(96)
	.regex(
		/^[a-z0-9][a-z0-9_-]*$/,
		'Use lowercase slugs with numbers, underscores, or hyphens',
	)

export const ShortlinkMetadataSchema = z
	.object({
		schemaVersion: z.literal(1),
		campaign: shortlinkMetadataSlug,
		campaignPhase: z.enum([
			'prelaunch_research',
			'warmup',
			'open_cart',
			'urgency',
			'post_close',
		]),
		sourceSurface: z.enum([
			'broadcast',
			'sequence',
			'support_reply',
			'social',
			'site',
			'operator_preview',
		]),
		sourceId: shortlinkMetadataSlug,
		contentSlug: shortlinkMetadataSlug.optional(),
		contentTopic: shortlinkMetadataSlug.optional(),
		contentIntent: z
			.enum([
				'problem_aware',
				'solution_aware',
				'proof',
				'objection',
				'checkout',
			])
			.optional(),
		valuePath: shortlinkMetadataSlug.optional(),
		linkRole: z
			.enum([
				'answer_option',
				'share_value_path',
				'signup_cta',
				'resource_link',
				'certificate_claim',
			])
			.optional(),
		signupSurface: z
			.enum(['skills_newsletter', 'skills_page', 'generic_site_signup'])
			.optional(),
		createdFor: z.enum(['campaign', 'evergreen', 'support', 'internal']),
	})
	.strict()

export type ShortlinkMetadata = z.infer<typeof ShortlinkMetadataSchema>

/**
 * Schema for creating a shortlink
 */
export const CreateShortlinkSchema = z.object({
	slug: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/)
		.optional(),
	url: z.string().url(),
	description: z.string().max(255).optional(),
	metadata: ShortlinkMetadataSchema.optional().nullable(),
})

export type CreateShortlinkInput = z.infer<typeof CreateShortlinkSchema>

/**
 * Schema for updating a shortlink
 */
export const UpdateShortlinkSchema = z.object({
	id: z.string(),
	slug: z
		.string()
		.min(1)
		.max(50)
		.regex(/^[a-zA-Z0-9_-]+$/)
		.optional(),
	url: z.string().url().optional(),
	description: z.string().max(255).optional(),
	metadata: ShortlinkMetadataSchema.optional().nullable(),
})

export type UpdateShortlinkInput = z.infer<typeof UpdateShortlinkSchema>

/**
 * Shortlink type from database
 */
export type Shortlink = typeof shortlink.$inferSelect

/**
 * Shortlink click event type
 */
export type ShortlinkClickEvent = typeof shortlinkClick.$inferSelect

/**
 * Shortlink with attribution counts
 */
export type ShortlinkWithAttributions = Shortlink & {
	signups: number
	purchases: number
}

/**
 * Analytics data for a shortlink
 */
export interface ShortlinkAnalytics {
	metadata: ShortlinkMetadata | null
	totalClicks: number
	clicksByDay: { date: string; clicks: number }[]
	topReferrers: { referrer: string; clicks: number }[]
	deviceBreakdown: { device: string; clicks: number }[]
	recentClicks: ShortlinkClickEvent[]
}

/**
 * Recent click stats across all shortlinks
 */
export interface RecentClickStats {
	last60Minutes: number
	last24Hours: number
}

/**
 * Attribution data type
 */
export type ShortlinkAttributionData = {
	shortlinkSlug: string
	email: string
	userId?: string
	type: 'signup' | 'purchase'
	metadata?: Record<string, unknown>
}
