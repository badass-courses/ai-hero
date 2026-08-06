export type CourseResource = {
	id: string
	type: string
	fields?: Record<string, unknown> | null
	resources?: CourseResourceRelation[] | null
}

export type CourseResourceRelation = {
	position?: number | null
	resource?: CourseResource | null
}

export type CourseProgress = {
	resourceId?: string | null
	updatedAt?: Date | null
	completedAt?: Date | null
}

export type CourseLessonDestination = {
	lesson: CourseResource
	workshop: CourseResource
	href: string
}

function getResourceSlug(resource: CourseResource): string | null {
	const slug = resource.fields?.slug
	return typeof slug === 'string' && slug.length > 0 ? slug : null
}

function orderedChildren(resource: CourseResource): CourseResource[] {
	return [...(resource.resources ?? [])]
		.sort((left, right) => (left.position ?? 0) - (right.position ?? 0))
		.map((wrapper) => wrapper.resource)
		.filter((child): child is CourseResource => Boolean(child))
}

export function getCourseWorkshops(
	courseResource: CourseResource,
): CourseResource[] {
	if (
		courseResource.type === 'workshop' ||
		courseResource.type === 'tutorial'
	) {
		return [courseResource]
	}

	return orderedChildren(courseResource).filter(
		(resource) =>
			resource.type === 'workshop' || resource.type === 'tutorial',
	)
}

function collectLessons(
	resource: CourseResource,
	workshop: CourseResource,
	destinations: CourseLessonDestination[],
) {
	for (const child of orderedChildren(resource)) {
		if (
			child.type === 'lesson' ||
			child.type === 'exercise' ||
			child.type === 'post'
		) {
			const workshopSlug = getResourceSlug(workshop)
			const lessonSlug = getResourceSlug(child)

			if (workshopSlug && lessonSlug) {
				destinations.push({
					lesson: child,
					workshop,
					href: `/workshops/${workshopSlug}/${lessonSlug}`,
				})
			}
			continue
		}

		if (child.type !== 'solution' && child.type !== 'videoResource') {
			collectLessons(child, workshop, destinations)
		}
	}
}

export function getCourseLessons(
	courseResource: CourseResource,
): CourseLessonDestination[] {
	const destinations: CourseLessonDestination[] = []

	for (const workshop of getCourseWorkshops(courseResource)) {
		collectLessons(workshop, workshop, destinations)
	}

	return destinations
}

function getProgressTime(progress: CourseProgress): number {
	return (progress.updatedAt ?? progress.completedAt)?.getTime() ?? 0
}

export function getLatestCourseLesson(
	courseResource: CourseResource,
	progress: CourseProgress[],
): CourseLessonDestination | null {
	const lessonsById = new Map(
		getCourseLessons(courseResource).map((destination) => [
			destination.lesson.id,
			destination,
		]),
	)

	const latestProgress = progress
		.filter(
			(item): item is CourseProgress & { resourceId: string } =>
				Boolean(item.resourceId && lessonsById.has(item.resourceId)),
		)
		.sort((left, right) => getProgressTime(right) - getProgressTime(left))[0]

	return latestProgress
		? lessonsById.get(latestProgress.resourceId) ?? null
		: null
}

export function getNextWorkshopLesson(
	productResources: CourseResource[],
	currentWorkshopId: string,
): CourseLessonDestination | null {
	const workshops = productResources.flatMap(getCourseWorkshops)
	const currentWorkshopIndex = workshops.findIndex(
		(workshop) => workshop.id === currentWorkshopId,
	)
	const nextWorkshop = workshops[currentWorkshopIndex + 1]

	if (currentWorkshopIndex < 0 || !nextWorkshop) return null

	return getCourseLessons(nextWorkshop)[0] ?? null
}
