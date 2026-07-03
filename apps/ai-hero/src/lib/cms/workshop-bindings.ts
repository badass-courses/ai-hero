import { addPostToList, removePostFromList } from '@/lib/lists-query'
import {
	getResourceParents,
	listResourcesForPicker,
} from '@/lib/resources-query'
import { batchUpdateResourcePositions } from '@/lib/tutorials-query'
import type { Workshop, WorkshopSchema } from '@/lib/workshops'
import { updateWorkshop } from '@/lib/workshops-query'

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
import { createWorkshopChild, listWorkshopContents } from './workshop-contents'

/**
 * Server bindings for the cms workshop editor (`createResourceEditor`).
 *
 * Mirrors `createPostBindings`: a thin factory whose verbs map 1:1 onto the
 * REAL server actions the legacy workshop editor already used —
 * `updateWorkshop` for saves, `addPostToList`/`removePostFromList` for child
 * attach/detach (yes, the workshop's own contents were always stored via the
 * list helpers), and `batchUpdateResourcePositions` (the tree editor's
 * whole-tree transactional position rewrite) for reorder + tier persistence.
 */
export interface CreateWorkshopBindingsOptions {
	/**
	 * Called after a save whose slug differs from the last-saved slug.
	 * Parity with the legacy form: redirect to the new edit URL.
	 */
	onSlugChange?: (slug: string) => void
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb
 * (`updateWorkshop` has no action param — state is just a field).
 */
function stateForAction(
	action: ResourceAction,
	current: Workshop['fields']['state'],
): Workshop['fields']['state'] {
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

export function createWorkshopBindings({
	onSlugChange,
}: CreateWorkshopBindingsOptions = {}): ResourceBindings<
	typeof WorkshopSchema
> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			return await updateWorkshop({
				id: values.id,
				type: 'workshop',
				fields: {
					...values.fields,
					state: stateForAction(action, values.fields.state || 'draft'),
				},
			})
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		getResourcePath: (slug) => `/workshops/${slug || ''}`,
		// "Part of" strip — reverse lookup covers cohort parents (join rows) and
		// product parents (contentResourceProduct) in one call.
		getParents: (id) => getResourceParents(id),
		// The ONE picker query (recent-first + search). The only picker surface
		// here is the Contents "+ Add", so default to the manifest's childTypes.
		listRecent: async ({ types, search, excludeIds, limit }) => {
			const items = await listResourcesForPicker({
				types: types?.length ? types : ['section', 'lesson', 'post'],
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
			// The REAL loader path (getWorkshop's nested resources query).
			list: (resourceId) => listWorkshopContents(resourceId),
			// Same server action the legacy list editor called for workshops —
			// appends at `resources.length` and returns the join row.
			add: async (resourceId, childId, opts) => {
				const row = await addPostToList({
					postId: childId,
					listId: resourceId,
					// Legacy parity: every add lands as 'standard'. addPostToList's
					// metadata type omits 'free' (tier changes go through reorder's
					// metadata carry-through instead), hence the narrow cast.
					metadata: {
						tier: (opts?.metadata?.tier ?? 'standard') as
							| 'standard'
							| 'premium'
							| 'vip',
					},
				})
				return { position: row?.position ?? 0 }
			},
			// Finds the row at top level or inside a section (legacy parity).
			remove: async (resourceId, childId) => {
				await removePostFromList({ postId: childId, listId: resourceId })
			},
			// Whole-tree transactional position rewrite keyed by
			// (resourceId, currentParentResourceId) — the exact server action the
			// legacy tree's saveTreeData called. Metadata (tier) rides along;
			// rows without metadata pass undefined, which drizzle skips, so
			// existing join metadata is preserved.
			reorder: async (_resourceId, updates) => {
				await batchUpdateResourcePositions(
					updates.map((update) => ({
						resourceId: update.childId,
						resourceOfId: update.parentId,
						currentParentResourceId: update.previousParentId,
						position: update.position,
						metadata: update.metadata,
					})),
				)
			},
			// "+ New section/lesson/post" quick-create — creates a draft child
			// via the app's real creation machinery and attaches it at the end
			// position (see `createWorkshopChild`; it returns the new row as a
			// ContentsItem, dropped here — the kit's create contract is void and
			// the pane refreshes via `contents.list` after every create).
			create: async (resourceId, type) => {
				await createWorkshopChild(resourceId, type)
			},
		},
		media: {
			// Flat per-type Cloudinary dir (events/products/lists precedent).
			upload: (file) => uploadToCloudinary(file, 'workshops'),
			// The app's primitive DB-backed image library (`imageResource` rows).
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
