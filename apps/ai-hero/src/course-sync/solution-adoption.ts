import { CourseSyncError } from './errors'
import type { SolutionResourceAdoptionCandidate } from './types'

export function assertAdoptableSolutionResource(input: {
	bindingId: string
	candidate: SolutionResourceAdoptionCandidate
	resource: {
		id: string
		type: string
		fields: Record<string, unknown>
	}
}) {
	const { bindingId, candidate, resource } = input
	const guid = /^solution_([a-f0-9]{12})$/.exec(resource.id)?.[1]
	const syncValue = resource.fields.courseSync
	const sync =
		syncValue && typeof syncValue === 'object'
			? (syncValue as Record<string, unknown>)
			: undefined
	const slug = resource.fields.slug
	if (
		resource.id === candidate.canonicalTargetResourceId ||
		!guid ||
		resource.type !== 'solution' ||
		typeof resource.fields.title !== 'string' ||
		typeof resource.fields.body !== 'string' ||
		typeof resource.fields.description !== 'string' ||
		resource.fields.state !== 'draft' ||
		resource.fields.visibility !== 'unlisted' ||
		resource.fields.videoResourceId !== candidate.solutionVideoResourceId ||
		resource.fields.optional !== false ||
		typeof slug !== 'string' ||
		!slug.endsWith(`~${guid}`) ||
		(syncValue !== undefined &&
			(!sync ||
				sync.bindingId !== bindingId ||
				sync.sourceLessonId !== candidate.sourceLessonId))
	) {
		throw new CourseSyncError(
			'SOLUTION_ADOPTION_SCOPE_MISMATCH',
			`Existing solution ${resource.id} does not match the guarded repair shape for lesson ${candidate.sourceLessonId}.`,
			409,
			{ category: 'target_precondition', retryable: false },
		)
	}
}
