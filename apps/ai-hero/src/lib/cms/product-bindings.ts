import {
	addResourceToProductById,
	listProductResources,
	removeResourceFromProduct,
	reorderProductResources,
} from '@/lib/product-resources-query'
import { archiveProduct, updateProduct } from '@/lib/products-query'
import { listResourcesForPicker } from '@/lib/resources-query'
import { z } from 'zod'

import { productSchema, type Product } from '@coursebuilder/core/schemas'
import type {
	ResourceAction,
	ResourceBindings,
} from '@coursebuilder/ui/cms/manifest'

import {
	createVideoLibraryBinding,
	listImageMediaAssets,
	listVideoPickerItems,
	uploadToCloudinary,
	uploadVideoMedia,
} from './post-bindings'

/**
 * Editor-side product schema for `zodResolver` — the core `productSchema`
 * plus the coercions text inputs need (the cms kit has no number FieldSpec;
 * numerics render as text inputs and zod does the converting):
 * - `quantityAvailable` is a STRICT `z.number()` in core; the input yields a
 *   string, so coerce (min −1 = unlimited, the bespoke input's floor).
 * - the cohort-archive day fields already coerce in core but reject '' — an
 *   emptied input must mean "unset", so preprocess ''→null first.
 * Output types are unchanged, so parsed values remain a valid `Product`.
 */
const emptyToNull = (value: unknown) =>
	value === '' || value === undefined ? null : value

export const ProductEditorSchema = productSchema.extend({
	quantityAvailable: z.coerce.number().int().min(-1).default(-1),
	fields: productSchema.shape.fields.extend({
		availableAfterDays: z.preprocess(
			emptyToNull,
			productSchema.shape.fields.shape.availableAfterDays,
		),
		accessDurationDays: z.preprocess(
			emptyToNull,
			productSchema.shape.fields.shape.accessDurationDays,
		),
	}),
})

export interface CreateProductBindingsOptions {
	/**
	 * Called after a save whose slug differs from the last-saved slug —
	 * redirect to the new edit URL. (The legacy form redirected to the PUBLIC
	 * product page after EVERY save; the cms editors stay put, post precedent.)
	 */
	onSlugChange?: (slug: string) => void
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb.
 */
function stateForAction(
	action: ResourceAction,
	current: Product['fields']['state'],
): Product['fields']['state'] {
	switch (action) {
		case 'publish':
			return 'published'
		case 'archive':
			return 'archived'
		case 'unpublish':
			return 'draft'
		default:
			return current
	}
}

/**
 * Server bindings for the cms product editor (`createResourceEditor`).
 *
 * Products are NOT contentResources — they live in the `Product` table with a
 * `price` relation and Stripe mirrors, and attach content via the
 * `ContentResourceProduct` join. That structural difference is absorbed
 * entirely here (which is what bindings are for):
 * - `update` routes 'archive' to `archiveProduct(id)` — the REAL signature.
 *   The legacy action bar passed the whole form-values object where a
 *   productId string was expected, so archiving from the UI always threw
 *   ("Product not found"); this cutover fixes that. Everything else goes to
 *   `updateProduct` (adapter: Stripe product update + price recreation when
 *   unitAmount/type/billingInterval change, then the products-row write).
 * - `contents` targets the product join table via the new product-scoped
 *   server actions (legacy remove/reorder hit `contentResourceResource` /
 *   the lists helpers and silently did nothing for products).
 * - no `getParents` — products are top-level; nothing is "Part of" them up.
 */
export function createProductBindings({
	onSlugChange,
}: CreateProductBindingsOptions = {}): ResourceBindings<
	typeof ProductEditorSchema
> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			if (action === 'archive') {
				// Dedicated verb: zeroes product/price/merchant status rows and
				// deactivates the product in Stripe.
				return await archiveProduct(values.id)
			}
			return await updateProduct({
				...values,
				fields: {
					...values.fields,
					state: stateForAction(action, values.fields.state ?? 'draft'),
				},
			})
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		getResourcePath: (slug) => `/products/${slug || ''}`,
		// The ONE picker query (recent-first + search). The only picker surface
		// here is the Resources "+ Add", so default to the manifest's childTypes.
		listRecent: async ({ types, search, excludeIds, limit }) => {
			const items = await listResourcesForPicker({
				types: types?.length ? types : ['post', 'event', 'workshop', 'cohort'],
				search,
				excludeIds,
				limit,
			})
			// Kit PickerItem wants `updatedAt?: string | Date` — never null.
			return items.map((item) => ({
				...item,
				updatedAt: item.updatedAt ?? undefined,
			}))
		},
		contents: {
			list: (resourceId) => listProductResources(resourceId),
			add: (resourceId, childId) =>
				addResourceToProductById({
					productId: resourceId,
					resourceId: childId,
				}),
			remove: async (resourceId, childId) => {
				await removeResourceFromProduct({
					productId: resourceId,
					resourceId: childId,
				})
			},
			// Flat list — every update's parent IS the product; only positions
			// move. (previousParentId always equals the product id here.)
			reorder: async (resourceId, updates) => {
				await reorderProductResources({
					productId: resourceId,
					updates: updates.map((update) => ({
						resourceId: update.childId,
						position: update.position,
					})),
				})
			},
		},
		media: {
			// Same Cloudinary pipeline as posts; same flat 'products' folder the
			// bespoke ImageResourceUploader used (uploadDirectory="products").
			upload: (file) => uploadToCloudinary(file, 'products'),
			list: listImageMediaAssets,
			// Kit-driven video upload (uploadthing → Inngest pipeline) — pairs
			// with `listVideos` to make the Media tab a full video surface.
			uploadVideo: uploadVideoMedia,
		},
		// Body editor "Video…" insert — the same library the Video tab lists.
		listVideos: listVideoPickerItems,
		// Media-tab video verbs: preview player + transcript + reprocess.
		videoLibrary: createVideoLibraryBinding(),
	}
}
