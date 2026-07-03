import type { Cohort, CohortSchema } from '@/lib/cohort'
import {
	attachCohortReminder,
	detachCohortReminder,
	listCohortReminders,
	listCohortWorkshops,
	updateCohort,
	updateCohortReminderSchedule,
} from '@/lib/cms/cohort-actions'
import { addPostToList, removePostFromList } from '@/lib/lists-query'
import {
	getResourceParents,
	listResourcesForPicker,
} from '@/lib/resources-query'
import { batchUpdateResourcePositions } from '@/lib/tutorials-query'

import type {
	ContentsItem,
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
 * Server bindings for the cms cohort editor (`createResourceEditor`).
 *
 * A factory for parity with `createPostBindings` (the slug-change redirect
 * needs the app router). Everything maps onto existing server actions:
 *
 * - `update` → `updateCohort` (wraps the generic `updateResource`, keeping the
 *   legacy save side-effects incl. the cohort entitlement-sync trigger, and
 *   stamps `fields.publishedAt` on publish).
 * - `getParents` → `getResourceParents` — the "Part of product" chip (doc-11):
 *   covers `ContentResourceProduct`, which the legacy cohort form never showed.
 * - `contents` (workshops) → the SAME writes the legacy list editor used:
 *   `addPostToList` / `removePostFromList` / `batchUpdateResourcePositions`
 *   (tier rides along in `metadata.tier`). NOTE: like the legacy editor,
 *   attach/detach/reorder do NOT fire entitlement sync (the defined
 *   `triggerResourceAddedSync`/`triggerResourceRemovedSync` were never called
 *   there either) — only a metadata save does.
 * - `reminders` → auth-gated wrappers over the real cohort-reminder join-row
 *   model (`cohort-email-reminders-query.ts`). Exact `sendAt` editing,
 *   create-new-email-in-place, and send-now/preview intentionally stay out of
 *   the kit widget; existing exact times render as a locked "At <time>" option.
 */
export interface CreateCohortBindingsOptions {
	/**
	 * Called after a save whose slug differs from the last-saved slug.
	 * Parity with the legacy form: redirect to the new edit URL.
	 */
	onSlugChange?: (slug: string) => void
	/**
	 * Per-row ⋯ "Edit" on the Contents tab — the client wrapper navigates to
	 * the child workshop's edit route (legacy tree context-menu Edit parity).
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
 * action anyway so the persisted state can never disagree with the verb.
 */
function stateForAction(
	action: ResourceAction,
	current: Cohort['fields']['state'],
): Cohort['fields']['state'] {
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

export function createCohortBindings({
	onSlugChange,
	onEditItem,
	getItemHref,
}: CreateCohortBindingsOptions = {}): ResourceBindings<typeof CohortSchema> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			return await updateCohort(
				{
					id: values.id,
					fields: {
						...values.fields,
						state: stateForAction(action, values.fields.state || 'draft'),
					},
					createdById: values.createdById || '',
				},
				action,
			)
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		getResourcePath: (slug) => (slug ? `/cohorts/${slug}` : '/cohorts'),
		// "Part of" strip — surfaces the owning product (ContentResourceProduct)
		// and any other parents; the legacy cohort editor showed neither.
		getParents: (id) => getResourceParents(id),
		// The ONE picker query (recent-first + search). Serves two surfaces here:
		// Workshops add (types from `contents.childTypes`) and reminder emails
		// (`types: ['email']` from RemindersField). Default to workshops.
		listRecent: async ({ types, search, excludeIds, limit }) => {
			const items = await listResourcesForPicker({
				types: types?.length ? types : ['workshop'],
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
			list: (resourceId) => listCohortWorkshops(resourceId),
			// Same join-row writes the legacy list editor used; the server
			// computes the end position (list length).
			add: async (resourceId, childId, opts) => {
				const row = await addPostToList({
					postId: childId,
					listId: resourceId,
					metadata: opts?.metadata?.tier
						? { tier: opts.metadata.tier as 'standard' | 'premium' | 'vip' }
						: undefined,
				})
				return { position: row?.position ?? 0 }
			},
			remove: async (resourceId, childId) => {
				await removePostFromList({ postId: childId, listId: resourceId })
			},
			// Full-tree position rewrite in one transaction — the exact write the
			// legacy tree's debounced save performed (tier carried in metadata).
			reorder: async (_resourceId, updates) => {
				await batchUpdateResourcePositions(
					updates.map((update) => ({
						resourceId: update.childId,
						resourceOfId: update.parentId,
						currentParentResourceId: update.previousParentId,
						position: update.position,
						// Undefined metadata leaves the join row's metadata untouched
						// (drizzle skips undefined columns in `.set`).
						metadata: update.metadata?.tier
							? { tier: update.metadata.tier }
							: undefined,
					})),
				)
			},
			// Per-row ⋯ "Edit" — the client wrapper routes to the child's editor.
			onEdit: onEditItem,
			// Per-row external-link icon → the child's public view URL.
			getItemHref,
		},
		media: {
			// Flat per-type Cloudinary dir (events/products/lists precedent).
			upload: (file) => uploadToCloudinary(file, 'cohorts'),
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
		reminders: {
			list: (resourceId) => listCohortReminders(resourceId),
			attach: async (resourceId, emailId, schedule) => {
				await attachCohortReminder(resourceId, emailId, schedule ?? undefined)
			},
			detach: async (resourceId, emailId) => {
				await detachCohortReminder(resourceId, emailId)
			},
			updateSchedule: async (resourceId, emailId, schedule) => {
				await updateCohortReminderSchedule(resourceId, emailId, schedule)
			},
		},
	}
}
