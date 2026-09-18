import { z } from 'zod'

import { priceSchema, ProductTypeSchema } from '@coursebuilder/core/schemas'
import {
	ContentResourceSchema,
	ResourceStateSchema,
	ResourceVisibilitySchema,
} from '@coursebuilder/core/schemas/content-resource-schema'

export const NewProductSchema = z.object({
	name: z.string().min(2).max(90),
	quantityAvailable: z.coerce.number().default(-1),
	price: z.coerce.number().gte(0).default(0),
	type: ProductTypeSchema,
	state: ResourceStateSchema.default('draft').optional(),
	visibility: ResourceVisibilitySchema.default('unlisted').optional(),
	availableAfterDays: z.coerce.number().int().positive().optional(),
	accessDurationDays: z.coerce.number().int().positive().optional(),
})

export type NewProduct = z.infer<typeof NewProductSchema>

export const ProductCreateApiSchema = NewProductSchema.extend({
	slug: z.string().min(2).max(191).optional(),
})

export const ProductUpdateApiSchema = z
	.object({
		id: z.string().min(1),
		name: z.string().min(2).max(90).optional(),
		price: z.coerce.number().gte(0).optional(),
		quantityAvailable: z.coerce.number().int().optional(),
		type: z
			.enum([
				'live',
				'self-paced',
				'membership',
				'cohort',
				'cohort-archive',
				'source-code-access',
			])
			.optional(),
		state: z.enum(['draft', 'published', 'archived', 'deleted']).optional(),
		visibility: z.enum(['public', 'private', 'unlisted']).optional(),
		slug: z.string().min(2).max(191).optional(),
		fields: z.record(z.string(), z.unknown()).optional(),
	})
	.refine(
		(input) =>
			Boolean(
				input.name ||
				input.price !== undefined ||
				input.quantityAvailable !== undefined ||
				input.type ||
				input.state ||
				input.visibility ||
				input.slug ||
				input.fields,
			),
		{ message: 'Provide at least one product field to update' },
	)

export const ProductContentSchema = ContentResourceSchema.merge(
	z.object({
		name: z.string().min(2).max(90),
		status: z.number().int().default(1),
		quantityAvailable: z.number().int().default(-1),
		price: priceSchema.nullable().optional(),
		fields: z.object({
			body: z.string().nullable().optional(),
			description: z.string().optional(),
			slug: z.string(),
			state: ResourceStateSchema.default('draft'),
			visibility: ResourceVisibilitySchema.default('unlisted'),
			type: ProductTypeSchema,
			discordRoleId: z.string().optional().nullable(),
			availableAfterDays: z.coerce.number().int().positive().optional(),
			accessDurationDays: z.coerce.number().int().positive().optional(),
		}),
	}),
)

export type ProductContent = z.infer<typeof ProductContentSchema>
