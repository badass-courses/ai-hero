import { onEventSave } from '@/app/(content)/events/[slug]/edit/actions'
import {
	attachEventReminder,
	detachEventReminder,
	listEventReminders,
	updateEvent,
	updateEventReminderSchedule,
} from '@/lib/cms/event-actions'
import type { Event, EventSchema } from '@/lib/events'
import { addTagToPost, removeTagFromPost } from '@/lib/posts-query'
import {
	getResourceParents,
	listResourcesForPicker,
} from '@/lib/resources-query'

import type { TagOption } from '@coursebuilder/ui/cms/fields/tag-field'
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
 * Server bindings for the cms event editor (`createResourceEditor`).
 *
 * A factory for parity with `createPostBindings` (the tag vocabulary is
 * server-fetched per request; the slug-change redirect needs the app router).
 * Everything maps onto existing server actions:
 *
 * - `update` → `updateEvent` (NEW wrapper in `cms/event-actions.ts` — the
 *   legacy form passed the generic `updateResource` directly; the wrapper
 *   keeps all its side-effects and stamps `fields.publishedAt` on publish).
 * - `onSave` → the legacy `onEventSave` server action UNCHANGED (Inngest
 *   RESOURCE_UPDATED_EVENT → Google Calendar sync, + revalidatePath), then
 *   the slug-change redirect.
 * - `getParents` → `getResourceParents` — the "Part of" strip surfaces the
 *   owning PRODUCT when the event is sold (ContentResourceProduct); the
 *   legacy event form never showed its attach state at all.
 * - `tags` → the same generic `contentResourceTag` writes the post editor
 *   uses (`addTagToPost`/`removeTagFromPost` take any resource id).
 * - `reminders` → auth-gated wrappers over the real event-reminder join-row
 *   model (`events-query.ts`, metadata type 'event-reminder'). The legacy
 *   tRPC surface (`api.events.*`) also had send-now/preview/create-in-place;
 *   those stay out of the kit widget for now (cohort precedent).
 * - `media` → same Cloudinary pipeline as posts; same flat 'events' folder
 *   the legacy tool-panel ImageResourceUploader used (uploadDirectory="events").
 */
export interface CreateEventBindingsOptions {
	/** Full tag vocabulary for the add-combobox (server-fetched via `getTags`). */
	availableTags: TagOption[]
	/**
	 * Called after a save whose slug differs from the last-saved slug.
	 * Parity with the legacy form: redirect to the new edit URL.
	 */
	onSlugChange?: (slug: string) => void
}

/**
 * The editor sets `fields.state` before submitting, but derive it from the
 * action anyway so the persisted state can never disagree with the verb.
 */
function stateForAction(
	action: ResourceAction,
	current: Event['fields']['state'],
): Event['fields']['state'] {
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

export function createEventBindings({
	availableTags,
	onSlugChange,
}: CreateEventBindingsOptions): ResourceBindings<typeof EventSchema> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			return await updateEvent(
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
			// The legacy save hook, unchanged: fires the Inngest calendar-sync
			// event (fields.calendarId flow) and revalidates the event page.
			await onEventSave(resource)
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		getResourcePath: (slug) => (slug ? `/events/${slug}` : '/events'),
		// "Part of" strip — surfaces the owning product (ContentResourceProduct)
		// when the event is sold; the legacy event editor showed nothing here.
		getParents: (id) => getResourceParents(id),
		// The ONE picker query (recent-first + search). In the event editor the
		// only picker surface is reminder emails, so default to ['email'].
		listRecent: async ({ types, search, excludeIds, limit }) => {
			const items = await listResourcesForPicker({
				types: types?.length ? types : ['email'],
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
			getResourceTags: (resource: Event) =>
				resource?.tags?.map(({ tag }: { tag: any }) => ({
					id: tag.id,
					label: tag.fields.label,
				})) ?? [],
			availableTags,
			// Immediate entity writes, independent of form save — the same generic
			// contentResourceTag inserts/deletes the post editor uses.
			add: async (resourceId, tag) => {
				await addTagToPost(resourceId, tag.id)
			},
			remove: async (resourceId, tag) => {
				await removeTagFromPost(resourceId, tag.id)
			},
		},
		reminders: {
			list: (resourceId) => listEventReminders(resourceId),
			attach: async (resourceId, emailId, schedule) => {
				await attachEventReminder(resourceId, emailId, schedule ?? undefined)
			},
			detach: async (resourceId, emailId) => {
				await detachEventReminder(resourceId, emailId)
			},
			updateSchedule: async (resourceId, emailId, schedule) => {
				await updateEventReminderSchedule(resourceId, emailId, schedule)
			},
		},
		media: {
			// Same Cloudinary pipeline as posts; same flat 'events' folder the
			// legacy tool-panel ImageResourceUploader used.
			upload: (file) => uploadToCloudinary(file, 'events'),
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
