import { z } from 'zod'

import {
	PickerItemSchema as KitPickerItemSchema,
	ResourceParentSchema as KitResourceParentSchema,
} from '@coursebuilder/ui/cms/manifest'

import {
	AnyResourceTypeSchema,
	POST_SUBTYPES,
	PostTypeSchema,
	RESOURCE_TYPES_WITH_VIDEO,
	ResourceType,
	ResourceTypeSchema,
} from './resource-types'

export {
	AnyResourceTypeSchema,
	POST_SUBTYPES,
	PostTypeSchema,
	ResourceTypeSchema,
	RESOURCE_TYPES_WITH_VIDEO,
}
export type {
	AnyResourceType,
	PostSubtypeString,
	PostType,
	ResourceType,
	ResourceTypeString,
} from './resource-types'

/**
 * Check if a given string is a valid top-level resource type
 * @param type - The type string to check
 * @returns true if the type is a valid top-level resource type
 */
export function isTopLevelResourceType(type: string): type is ResourceType {
	return ResourceTypeSchema.safeParse(type).success
}

/**
 * Check if a given string is a valid post subtype
 * @param type - The type string to check
 * @returns true if the type is a valid post subtype
 */
export function isPostSubtype(type: string): boolean {
	return PostTypeSchema.safeParse(type).success
}

/**
 * Check if a resource type supports video
 * @param type - The resource type to check
 * @returns true if the type supports video uploads
 */
export function supportsVideo(type: string): boolean {
	// Check if it's a top-level resource type that supports video
	if (isTopLevelResourceType(type)) {
		return RESOURCE_TYPES_WITH_VIDEO.includes(type)
	}

	// Check if it's a post subtype that supports video
	const postTypesWithVideo = ['article']
	return postTypesWithVideo.includes(type)
}

/**
 * A parent resource from one-level reverse lookup — powers the "Part of"
 * strip in the resource editor (post ∈ list, lesson ∈ workshop,
 * workshop ∈ cohort, cohort/workshop ∈ product).
 *
 * Extends the kit's `ResourceParentSchema` (id/type/title/href/detail) with a
 * required `slug`, so results hand straight to `bindings.getParents` as-is.
 */
export const ResourceParentSchema = KitResourceParentSchema.extend({
	slug: z.string(),
})
export type ResourceParent = z.infer<typeof ResourceParentSchema>

/**
 * Input for the recent-first resource picker query
 * (`listResourcesForPicker` / `api.contentResources.listForPicker`).
 */
export const ListResourcesForPickerInputSchema = z.object({
	types: z.array(z.string()).min(1),
	/** Case-insensitive title substring match (DB LIKE, TypeSense untouched). */
	search: z.string().optional(),
	excludeIds: z.array(z.string()).default([]),
	limit: z.number().int().min(1).max(100).default(20),
})
export type ListResourcesForPickerInput = z.input<
	typeof ListResourcesForPickerInputSchema
>

/**
 * Lean row shape returned by the picker query — enough to render a
 * recent-first combobox without shipping resource bodies to the client.
 *
 * Extends the kit's `PickerItemSchema`, narrowing to what the DB query
 * actually guarantees: `slug`/`state` are always selected (required, not
 * optional) and `updatedAt` is the raw column (`Date | null`, not the kit's
 * optional string-or-date — bindings map `null` to `undefined` at the seam).
 */
export const PickerItemSchema = KitPickerItemSchema.extend({
	slug: z.string(),
	state: z.string(),
	updatedAt: z.date().nullable(),
})
export type PickerItem = z.infer<typeof PickerItemSchema>

/**
 * Input for the video-library picker query (`listVideoResourcesForPicker`).
 * A sibling of `ListResourcesForPickerInputSchema`: videoResources have no
 * `fields.title`/slug, so search matches the id (filename-derived) instead,
 * and rows need mux-specific extras (thumbnail, duration).
 */
export const ListVideoResourcesForPickerInputSchema = z.object({
	/** Case-insensitive substring match on the resource id (the filename). */
	search: z.string().optional(),
	excludeIds: z.array(z.string()).default([]),
	// Default 20 fits picker popovers; the Media tab asks for the max (its
	// grid is the whole library surface, like getAllImageResources).
	limit: z.number().int().min(1).max(200).default(20),
})
export type ListVideoResourcesForPickerInput = z.input<
	typeof ListVideoResourcesForPickerInputSchema
>

/**
 * Lean video-library row: enough for a picker row with a small Mux poster,
 * the id-as-title (videoResources carry no title), duration, and recency.
 *
 * Derived from the kit's `PickerItemSchema` (id/title/thumbnailUrl) — an
 * app-specific extension because videoResources don't fit the full kit row:
 * no type/slug/updatedAt, a required lifecycle `state`, plus Mux extras.
 */
export const VideoPickerItemSchema = KitPickerItemSchema.pick({
	id: true,
	/** The id doubles as the display title — it's the unique upload filename. */
	title: true,
	/** Mux poster URL — absent until the Mux asset exists. */
	thumbnailUrl: true,
}).extend({
	/** Video lifecycle state: 'processing' | 'preparing' | 'ready' | … */
	state: z.string(),
	/** Duration in seconds — absent until processing finishes. */
	duration: z.number().nullable(),
	createdAt: z.date().nullable(),
})
export type VideoPickerItem = z.infer<typeof VideoPickerItemSchema>

/**
 * Configuration for creating resources
 * Used to define the available resource types and subtypes for creation
 */
export interface ResourceCreationConfig {
	title: string
	availableTypes: Array<
		| { type: 'post'; postTypes: string[] }
		| { type: Exclude<ResourceType, 'post'> }
	>
	defaultType: { type: ResourceType; postType?: string }
}

/**
 * Input for creating a new resource
 */
export interface CreateResourceInput {
	type: ResourceType
	title: string
}
