import { addPostToList, removePostFromList } from '@/lib/lists-query'
import type { Page, PageSchema } from '@/lib/pages'
import { updatePage } from '@/lib/pages-query'
import {
	getResourceParents,
	listResourcesForPicker,
} from '@/lib/resources-query'
import { batchUpdateResourcePositions } from '@/lib/tutorials-query'

import type {
	ResourceAction,
	ResourceBindings,
} from '@coursebuilder/ui/cms/manifest'

import { listPageContents } from './page-contents'
import {
	createVideoLibraryBinding,
	listImageMediaAssets,
	listVideoPickerItems,
	uploadToCloudinary,
	uploadVideoMedia,
} from './post-bindings'

/**
 * Server bindings for the cms page editor (`createResourceEditor`).
 *
 * Mirrors `createPostBindings`: a thin factory whose verbs map 1:1 onto the
 * REAL server actions the legacy page editor already used — `updatePage` for
 * saves (single-arg upsert; slug intentionally NOT regenerated on title
 * change, that policy lives server-side), `addPostToList`/`removePostFromList`
 * for the curated-collection attach/detach (page children were always stored
 * via the generic list helpers), and `batchUpdateResourcePositions` for
 * reorder.
 */
export interface CreatePageBindingsOptions {
	/** The page's id — scopes Cloudinary uploads to `pages/{id}`. */
	resourceId: string
	/**
	 * Called after a save whose slug differs from the last-saved slug —
	 * redirect to the new edit URL. (The legacy `onPageSave` → /admin/coupons
	 * redirect was dead code: imported but never passed to the form.)
	 */
	onSlugChange?: (slug: string) => void
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb
 * (`updatePage` has no action param — state is just a field).
 */
function stateForAction(
	action: ResourceAction,
	current: Page['fields']['state'],
): Page['fields']['state'] {
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

export function createPageBindings({
	resourceId,
	onSlugChange,
}: CreatePageBindingsOptions): ResourceBindings<typeof PageSchema> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			return await updatePage({
				...values,
				fields: {
					...values.fields,
					state: stateForAction(action, values.fields.state || 'draft'),
					// Persist null (not `{ url: '' }`, and not a stripped key —
					// updatePage merges fields per-key, so omitting would keep the
					// old image) so clearing the social image actually clears it.
					socialImage: values.fields.socialImage?.url
						? values.fields.socialImage
						: null,
				},
			} as Page)
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		// Pages genuinely render at the site root (legacy parity).
		getResourcePath: (slug) => `/${slug || ''}`,
		getParents: (id) => getResourceParents(id),
		// The ONE picker query (recent-first + search). The only picker surface
		// here is the Resources "+ Add", so default to the manifest's childTypes
		// (the legacy topLevelResourceTypes).
		listRecent: async ({ types, search, excludeIds, limit }) => {
			const items = await listResourcesForPicker({
				types: types?.length ? types : ['article', 'post', 'cohort'],
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
			// The REAL loader path (getPage's nested resources query).
			list: (pageId) => listPageContents(pageId),
			// Same generic join-row server action the legacy list editor used —
			// appends at `resources.length`. No tier metadata: the legacy page
			// config had `showTierSelector: false`.
			add: async (pageId, childId) => {
				const row = await addPostToList({ postId: childId, listId: pageId })
				return { position: row?.position ?? 0 }
			},
			remove: async (pageId, childId) => {
				await removePostFromList({ postId: childId, listId: pageId })
			},
			// Whole-tree transactional position rewrite (pages are flat, so every
			// row's parent is the page itself).
			reorder: async (_pageId, updates) => {
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
		},
		media: {
			// DELIBERATE FIX of the legacy copy-paste bug: the old image tool
			// uploaded page images to Cloudinary dir 'workshops'. Honest per-page
			// dir instead (post precedent: `posts/{id}`).
			upload: (file) => uploadToCloudinary(file, `pages/${resourceId}`),
			// The app's DB-backed image library (`imageResource` rows) — the same
			// source the legacy ImageResourceBrowser rendered.
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
