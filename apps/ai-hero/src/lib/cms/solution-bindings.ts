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
import { stripClientPublishedAt } from '@coursebuilder/ui/cms/resource-state'

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
			// createSolution only persists title/body/slug/description (and always
			// writes state 'draft' / visibility 'unlisted'), so a follow-up update
			// persists the remaining form fields and the action-derived state.
			if (!values.id) {
				const created = await createSolution({
					lessonId: lesson.id,
					title: values.fields.title || '',
					body: values.fields.body || '',
					slug: values.fields.slug,
					description: values.fields.description || '',
				})
				// Hand the id to the editor BEFORE the follow-up state update: if
				// that update fails, the editor already holds the new row's id, so a
				// retry becomes an UPDATE instead of creating a duplicate solution.
				onCreated?.({ id: created.id })
				const derivedState = stateForAction(action, 'draft')
				// Clamp on create: publish-on-first-save is fine, but archiving a
				// never-saved solution is meaningless and would persist a phantom
				// lesson↔solution join row.
				const createdState =
					derivedState === 'published' ? derivedState : 'draft'
				// The follow-up update ALWAYS runs: it carries the full form fields
				// (visibility, optional, …) that createSolution ignores — without it
				// the first save would silently drop everything but the basics.
				const createdUpdate = await updateSolution({
					id: created.id,
					type: 'solution',
					fields: {
						...stripClientPublishedAt(values.fields),
						state: createdState,
					},
				} as Partial<Solution>)
				return createdUpdate ?? created
			}
			// UPDATE mode. Slugs never auto-regenerate on title change — only an
			// explicit edit to the slug field changes the slug.
			const updated = await updateSolution({
				id: values.id,
				type: 'solution',
				fields: {
					...stripClientPublishedAt(values.fields),
					state: stateForAction(action, values.fields.state || 'draft'),
				},
			} as Partial<Solution>)
			// null here means nothing was persisted — don't let the kit report 'Saved'.
			if (updated == null) {
				throw new Error('Solution save failed — nothing was persisted')
			}
			return updated
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
