/**
 * Schema-only half of list membership, split from the service so
 * `agent-api-contracts.ts` can register these shapes in the OpenAPI document
 * without dragging the database import along (same split as
 * `shortlinks-types.ts` and `upload-contracts.ts`).
 */
import { z } from 'zod'

import { ContentResourceSchema } from '@coursebuilder/core/schemas/content-resource-schema'

export const AddListItemInputSchema = z.object({
	resourceId: z.string().min(1),
	/** A section id to nest under. Omit to add at the top level of the list. */
	parentId: z.string().min(1).optional(),
	metadata: z
		.object({ tier: z.string().optional() })
		.passthrough()
		.optional(),
})

export const MoveListItemsInputSchema = z.object({
	items: z
		.array(
			z.object({
				resourceId: z.string().min(1),
				/** Omit to reorder in place; pass the list id to pull out of a section. */
				parentId: z.string().min(1).optional(),
				position: z.number().int().min(0),
			}),
		)
		.min(1)
		// One entry per resource: a second entry would be planned against row
		// state the first entry already changed, and the response would report
		// a move that never happened.
		.superRefine((items, ctx) => {
			const seen = new Set<string>()
			for (const item of items) {
				if (seen.has(item.resourceId)) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: `resourceId ${item.resourceId} appears more than once`,
					})
				}
				seen.add(item.resourceId)
			}
		}),
})

/** The join row the add answers with, its resource included. */
export const ListItemRowResponseSchema = z
	.object({
		resourceOfId: z.string(),
		resourceId: z.string(),
		position: z.number(),
		metadata: z.record(z.string(), z.any()).nullish(),
		resource: ContentResourceSchema.nullish(),
	})
	.passthrough()

/** Where the removed item sat. */
export const ListItemLocationResponseSchema = z.object({
	resourceId: z.string(),
	/** The list itself, or the section the item hung off. */
	parentId: z.string(),
	position: z.number(),
})

/** The applied move plan, one row per item. */
export const MoveListItemsResponseSchema = z.array(
	z.object({
		resourceId: z.string(),
		fromParentId: z.string(),
		toParentId: z.string(),
		position: z.number(),
	}),
)
