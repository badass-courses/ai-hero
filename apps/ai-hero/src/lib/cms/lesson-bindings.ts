import type { Lesson, LessonSchema, LessonUpdate } from '@/lib/lessons'
import { updateLesson } from '@/lib/lessons-query'
import { addTagToPost, removeTagFromPost } from '@/lib/posts-query'
import { getResourceParents } from '@/lib/resources-query'

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
 * Server bindings for the cms workshop-lesson editor (`createResourceEditor`).
 *
 * Mirrors `createPostBindings`: a thin factory whose verbs map 1:1 onto the
 * REAL server actions the legacy lesson editor used — `updateLesson` for
 * saves, `addTagToPost`/`removeTagFromPost` for the tag chips (the legacy
 * TagField called the same post-named-but-generic actions for lessons), and
 * `getResourceParents` for the "Part of" strip (lesson ∈ workshop/section —
 * new here; the legacy edit surface never showed its parent workshop).
 */
export interface CreateLessonBindingsOptions {
	/** URL `module` segment — lesson paths live under `/workshops/{module}/`. */
	moduleSlug: string
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
 * action anyway so the persisted state can never disagree with the verb
 * (`updateLesson` has no action param — state is just a field).
 */
function stateForAction(
	action: ResourceAction,
	current: Lesson['fields']['state'],
): Lesson['fields']['state'] {
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

export function createLessonBindings({
	moduleSlug,
	availableTags,
	onSlugChange,
}: CreateLessonBindingsOptions): ResourceBindings<typeof LessonSchema> {
	return {
		update: async (values, action) => {
			if (!values.id || !values.fields) {
				throw new Error('Invalid resource data')
			}
			const lessonUpdate = {
				id: values.id,
				fields: {
					title: values.fields.title || '',
					body: values.fields.body || '',
					slug: values.fields.slug || '',
					description: values.fields.description ?? '',
					state: stateForAction(action, values.fields.state || 'draft'),
					visibility: values.fields.visibility || 'public',
					github: values.fields.github ?? '',
					// LessonUpdate's type omits gitpod (the legacy config silently
					// dropped it on save — the one field its form edited but never
					// persisted). updateLesson spreads input.fields over the current
					// fields at runtime, so passing it through makes the editor honest.
					gitpod: values.fields.gitpod ?? '',
					thumbnailTime: values.fields.thumbnailTime ?? 0,
					optional: values.fields.optional ?? false,
					prompt: values.fields.prompt ?? '',
				},
				// updateLesson does not persist tags — tag writes happen immediately
				// via the tags binding below (addTagToPost / removeTagFromPost).
				tags: values.tags || [],
			} as LessonUpdate
			return await updateLesson(lessonUpdate)
		},
		onSave: async (resource, hasNewSlug) => {
			const slug = resource?.fields?.slug
			if (hasNewSlug && slug) {
				onSlugChange?.(slug)
			}
		},
		// Lesson pages live under the workshop (legacy getResourcePath parity).
		getResourcePath: (slug) => `/workshops/${moduleSlug}/${slug || ''}`,
		media: {
			// Flat per-type Cloudinary dir (events/products/lists precedent).
			upload: (file) => uploadToCloudinary(file, 'lessons'),
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
		// "Part of" strip — reverse lookup over the join table: lesson ∈ workshop
		// (or ∈ section for sectioned workshops — one level deep by design).
		getParents: (id) => getResourceParents(id),
		tags: {
			getResourceTags: (resource: Lesson) =>
				resource?.tags?.map(({ tag }) => ({
					id: tag.id,
					label: tag.fields.label,
				})) ?? [],
			availableTags,
			// Immediate entity writes, independent of form save — the same generic
			// server actions the legacy lesson TagField called.
			add: async (resourceId, tag) => {
				await addTagToPost(resourceId, tag.id)
			},
			remove: async (resourceId, tag) => {
				await removeTagFromPost(resourceId, tag.id)
			},
		},
		// bindings.ai (SEO "✦ Generate") is DELIBERATELY unwired — same reason as
		// posts: the legacy path is fire-and-forget Inngest + PartyKit socket,
		// which can't RETURN the generated string the kit contract requires.
	}
}
