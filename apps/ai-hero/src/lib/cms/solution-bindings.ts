import {
	createVideoLibraryBinding,
	listImageMediaAssets,
	listVideoPickerItems,
	uploadToCloudinary,
	uploadVideoMedia,
} from './post-bindings'
import type { Solution, SolutionSchema } from '@/lib/solution'
import { createSolution, updateSolution } from '@/lib/solutions-query'

import type {
	ResourceAction,
	ResourceBindings,
	ResourceParent,
} from '@coursebuilder/ui/cms/manifest'

/**
 * Server bindings for the cms solution editor (`createResourceEditor`).
 *
 * A solution is the lesson's single child resource, edited at
 * `/workshops/{module}/{lesson}/solution/edit` (no slug segment of its own).
 * Two things distinguish it from the other bindings factories:
 *
 * - CREATE-ON-SAVE (legacy `EditSolutionForm` parity): when no solution
 *   exists the page passes a placeholder resource (`id: ''`, pre-seeded
 *   `~guid` slug) and the first save calls `createSolution` — which also
 *   inserts the lesson↔solution join row. `onCreated` lets the page refetch
 *   so the editor remounts holding the real row (a second save must UPDATE,
 *   never create a duplicate).
 * - The lesson↔solution navigation runs through `getParents`: the parent
 *   lesson is known server-side and baked in via closure (a reverse lookup
 *   can't work in create mode — there's no id to look up yet), so the
 *   "Part of" strip is the "Back to Lesson" link.
 */
export interface CreateSolutionBindingsOptions {
	/** URL `module` segment. */
	moduleSlug: string
	/** The parent lesson (fetched server-side by the edit page). */
	lesson: { id: string; slug: string; title: string }
	/** Called after create-on-save persists the first row — refetch/remount. */
	onCreated?: (solution: { id: string }) => void
}

/** Same verb→state derivation as the other bindings factories. */
function stateForAction(
	action: ResourceAction,
	current: Solution['fields']['state'],
): Solution['fields']['state'] {
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

export function createSolutionBindings({
	moduleSlug,
	lesson,
	onCreated,
}: CreateSolutionBindingsOptions): ResourceBindings<typeof SolutionSchema> {
	const lessonEditHref = `/workshops/${moduleSlug}/${lesson.slug}/edit`

	return {
		update: async (values, action) => {
			if (!values.fields) {
				throw new Error('Invalid resource data')
			}
			// CREATE mode — first save of the page's placeholder resource.
			// Legacy parity: createSolution takes only these fields and always
			// writes state 'draft' / visibility 'unlisted'; a publish-on-first-save
			// lands as draft, exactly as the legacy form behaved.
			if (!values.id) {
				const created = await createSolution({
					lessonId: lesson.id,
					title: values.fields.title || '',
					body: values.fields.body || '',
					slug: values.fields.slug,
					description: values.fields.description || '',
				})
				onCreated?.({ id: created.id })
				return created
			}
			// UPDATE mode. Note updateSolution regenerates the slug from the title
			// on title changes (solutions have no slug field in the editor).
			return await updateSolution({
				id: values.id,
				type: 'solution',
				fields: {
					...values.fields,
					state: stateForAction(action, values.fields.state || 'draft'),
				},
			} as Partial<Solution>)
		},
		// Solutions have no page of their own — Preview / View on site goes to
		// the parent lesson (legacy getResourcePath parity). The slug arg is the
		// SOLUTION's slug, so it's deliberately ignored.
		getResourcePath: () => `/workshops/${moduleSlug}/${lesson.slug}`,
		// Always-on Media tab (images + videos), same experience as every type.
		media: {
			upload: (file) => uploadToCloudinary(file, 'solutions'),
			list: listImageMediaAssets,
			uploadVideo: uploadVideoMedia,
		},
		listVideos: listVideoPickerItems,
		videoLibrary: createVideoLibraryBinding(),
		// "Part of" strip = the lesson↔solution navigation (replaces the legacy
		// "Back to Lesson" button). Closure-baked: works in create mode too.
		getParents: async (): Promise<ResourceParent[]> => [
			{
				id: lesson.id,
				type: 'lesson',
				title: lesson.title,
				href: lessonEditHref,
			},
		],
	}
}
