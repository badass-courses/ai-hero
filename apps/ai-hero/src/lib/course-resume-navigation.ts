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
		(resource) => resource.type === 'workshop' || resource.type === 'tutorial',
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

		if (child.type === 'workshop' || child.type === 'tutorial') {
			collectLessons(child, child, destinations)
		} else if (child.type === 'section') {
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

/** Resolve only resources present in the tree, with their actual owning workshop. */
export function getWorkshopResourceHref(
	navigation: CourseResource | null | undefined,
	target: Partial<Pick<CourseResource, 'id' | 'type'>> | null | undefined,
): string | null {
	if (!navigation || !target?.id || !target.type) return null
	const { id: targetId, type: targetType } = target

	function resolve(
		resource: CourseResource,
		owner: CourseResource | null,
		allowWorkshopPage = true,
	): string | null {
		const slug = getResourceSlug(resource)
		const isWorkshop =
			resource.type === 'workshop' || resource.type === 'tutorial'
		if (isWorkshop && allowWorkshopPage) {
			return slug ? `/workshops/${slug}` : null
		}
		if (resource.type === 'section' || isWorkshop) {
			for (const child of orderedChildren(resource)) {
				const href = resolve(child, isWorkshop ? resource : owner, false)
				if (href) return href
			}
			return null
		}
		if (['lesson', 'exercise', 'post'].includes(resource.type)) {
			const workshopSlug = owner && getResourceSlug(owner)
			return workshopSlug && slug ? `/workshops/${workshopSlug}/${slug}` : null
		}
		return null
	}

	function find(
		resource: CourseResource,
		workshop: CourseResource | null,
	): string | null {
		const owner =
			resource.type === 'workshop' || resource.type === 'tutorial'
				? resource
				: workshop

		if (resource.id === targetId && resource.type === targetType) {
			return resolve(resource, owner)
		}

		if (
			!['workshop', 'tutorial', 'cohort', 'section'].includes(resource.type)
		) {
			return null
		}
		for (const child of orderedChildren(resource)) {
			const href = find(child, owner)
			if (href) return href
		}
		return null
	}

	return find(navigation, null)
}

/** First playable destination, or a child workshop overview. Never an untyped slug. */
export function getWorkshopStartHref(
	navigation: CourseResource | null | undefined,
): string | null {
	if (!navigation) return null
	for (const child of orderedChildren(navigation)) {
		const href = getWorkshopResourceHref(navigation, child)
		if (href) return href
	}
	return null
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
		.filter((item): item is CourseProgress & { resourceId: string } =>
			Boolean(item.resourceId && lessonsById.has(item.resourceId)),
		)
		.sort((left, right) => getProgressTime(right) - getProgressTime(left))[0]

	return latestProgress
		? (lessonsById.get(latestProgress.resourceId) ?? null)
		: null
}
