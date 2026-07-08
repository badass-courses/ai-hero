import type { List, ListSchema } from '@/lib/lists'
import {
	addPostToList,
	removePostFromList,
	updateList,
	updateListItemFields,
} from '@/lib/lists-query'
import { addTagToPost, removeTagFromPost } from '@/lib/posts-query'
import {
	getResourceParents,
	listResourcesForPicker,
} from '@/lib/resources-query'
import { batchUpdateResourcePositions } from '@/lib/tutorials-query'

import type { TagOption } from '@coursebuilder/ui/cms/fields/tag-field'
import type {
	ContentsItem,
	ResourceAction,
	ResourceBindings,
} from '@coursebuilder/ui/cms/manifest'

import { createInList, listListContents } from './list-contents'
import {
	createVideoLibraryBinding,
	listImageMediaAssets,
	listVideoPickerItems,
	uploadToCloudinary,
	uploadVideoMedia,
} from './post-bindings'

/**
 * Server bindings for the cms list editor (`createResourceEditor`).
 *
 * Mirrors `createWorkshopBindings`: a thin factory whose verbs map 1:1 onto
 * the REAL server actions the legacy list editor already used — `updateList`
 * for saves, `addPostToList`/`removePostFromList` for child attach/detach
 * (the exact actions the post editor's lists field calls from the other
 * side of the same join row), and `batchUpdateResourcePositions` (the tree
 * editor's whole-tree transactional position rewrite) for reorder.
 */
export interface CreateListBindingsOptions {
	/** Full tag vocabulary for the add-combobox (server-fetched via `getTags`). */
	availableTags: TagOption[]
	/**
	 * Called after a save whose slug differs from the last-saved slug.
	 * Parity with the legacy form: redirect to the new edit URL.
	 */
	onSlugChange?: (slug: string) => void
	/**
	 * Per-row ⋯ "Edit" on the Resources tab — the client wrapper navigates to
	 * the child's edit route (replaces the legacy tree's inline title editing).
	 */
	onEditItem?: (item: ContentsItem) => void
	/**
	 * Public view URL for a row — renders the per-row external-link icon.
	 * Pure client mapping (e.g. `getResourcePath(type, slug, 'view')`).
	 */
	getItemHref?: (item: ContentsItem) => string | undefined
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb
 * (`updateList` takes the action for its ability check + TypeSense upsert;
 * state itself is just a field).
 */
function stateForAction(
	action: ResourceAction,
	current: List['fields']['state'],
): List['fields']['state'] {
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

export function createListBindings({
	availableTags,
	onSlugChange,
	onEditItem,
	getItemHref,
}: CreateListBindingsOptions): ResourceBindings<typeof ListSchema> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			// Same payload shape the legacy `updateResource` built. `resources`
			// and `tags` ride along for the ListUpdate type but `updateList`
			// persists fields only — contents are join rows written immediately
			// by the contents binding below, tags by the tags binding.
			const updated = await updateList(
				{
					id: values.id,
					fields: {
						title: values.fields.title ?? '',
						body: values.fields.body ?? null,
						slug: values.fields.slug ?? '',
						type: values.fields.type ?? 'nextUp',
						description: values.fields.description ?? '',
						state: stateForAction(action, values.fields.state || 'draft'),
						visibility: values.fields.visibility ?? 'unlisted',
						image: values.fields.image ?? null,
						github: values.fields.github ?? null,
						gitpod: values.fields.gitpod ?? null,
					},
					resources: values.resources ?? [],
					tags: values.tags ?? [],
				},
				action,
			)
			// null here means nothing was persisted — don't let the kit report 'Saved'.
			if (updated == null) {
				throw new Error('List save failed — nothing was persisted')
			}
			return updated
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		// Lists live at the site root — no /lists/ prefix (legacy getResourcePath).
		getResourcePath: (slug) => `/${slug || ''}`,
		// "Part of" strip — reverse lookup (cohorts/products), one call.
		getParents: (id) => getResourceParents(id),
		// The ONE picker query (recent-first + search). The only picker surface
		// here is the Resources "+ Add", so default to the manifest's childTypes.
		listRecent: async ({ types, search, excludeIds, limit }) => {
			const items = await listResourcesForPicker({
				types: types?.length ? types : ['post'],
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
		tags: {
			getResourceTags: (resource: List) =>
				resource?.tags?.map(({ tag }) => ({
					id: tag.id,
					label: tag.fields.label,
				})) ?? [],
			availableTags,
			// Immediate entity writes — the generic contentResourceTag actions the
			// legacy list TagField called (they take any resource id, not just posts).
			add: async (resourceId, tag) => {
				await addTagToPost(resourceId, tag.id)
			},
			remove: async (resourceId, tag) => {
				await removeTagFromPost(resourceId, tag.id)
			},
		},
		contents: {
			// The REAL loader path (getList's resources query).
			list: (resourceId) => listListContents(resourceId),
			// Same server action the legacy add flows called (create-modal AND
			// search-modal both landed on `addPostToList` with tier 'standard') —
			// appends at `resources.length` and returns the join row.
			add: async (resourceId, childId, opts) => {
				const row = await addPostToList({
					postId: childId,
					listId: resourceId,
					// Legacy parity: every add lands as 'standard'. addPostToList's
					// metadata type omits 'free', hence the narrow cast.
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
			// legacy tree's saveTreeData called. Metadata (tier) rides along; rows
			// without metadata pass undefined, which drizzle skips, so existing
			// join metadata is preserved.
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
			// "+ New {type}" quick-create — posts via createPost, sections via
			// createResource, then addPostToList. Honors the type the tree's
			// create button passes (childTypes: post + section).
			create: async (resourceId, type) => {
				await createInList(resourceId, type)
			},
			// Per-row ⋯ "Edit" — the client wrapper routes to the child's editor.
			onEdit: onEditItem,
			// Inline section edit — sections have no edit route, so persist their
			// title/description in place. updateListItemFields routes a section
			// (non-post/list) through updateContentResourceFields.
			editSection: async (_resourceId, sectionId, fields) => {
				await updateListItemFields(sectionId, {
					title: fields.title,
					description: fields.description,
				})
			},
			// Per-row external-link icon → the child's public view URL.
			getItemHref,
		},
		media: {
			// Same Cloudinary dir the legacy tool-panel uploader used: 'lists'
			// (ImageResourceUploader uploadDirectory — flat, not per-id).
			upload: (file) => uploadToCloudinary(file, 'lists'),
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
