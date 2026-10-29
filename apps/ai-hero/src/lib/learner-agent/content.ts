import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { CohortOfficeHoursSessionsSchema } from '@/lib/cohort-office-hours'
import { getCachedCohortNavigation } from '@/lib/cohort-navigation-query'
import type { ResourceNavigation } from '@/lib/content-navigation'
import {
	getExerciseSolution,
	getLesson,
	getLessonVideoTranscript,
} from '@/lib/lessons-query'
import { sanitizeResourcePayload } from '@/lib/resource-api-sanitizer'
import { getLessonSessionExtract } from '@/lib/session-extract-query'
import {
	getCachedWorkshopNavigation,
	getWorkshopsForLesson,
} from '@/lib/workshops-query'
import { getResourcePath } from '@/utils/resource-paths'
import { and, eq, isNull, sql } from 'drizzle-orm'

import type {
	ContentPort,
	CourseLesson,
	CourseStructure,
	LessonContent,
} from '@ai-hero/learner-agent'

import { getCourseResource } from './course-resources'

const LESSON_TYPES = new Set(['lesson', 'exercise', 'post'])

const isLive = (fields: Record<string, any> | null | undefined) =>
	!fields?.state || fields.state === 'published'

export function lessonPath(workshopSlug: string, lessonSlug: string) {
	return getResourcePath('lesson', lessonSlug, 'view', {
		parentType: 'workshop',
		parentSlug: workshopSlug,
	})
}

/**
 * A workshop's sections and lessons from its navigation tree: the same
 * cached tree every lesson page loads. Lessons sitting directly in the
 * workshop are grouped into an untitled section, in authored order.
 */
export function workshopSections(
	navigation: ResourceNavigation | null,
	baseUrl: string,
): CourseStructure['workshops'][number]['sections'] {
	const workshopSlug = navigation?.fields?.slug
	if (!navigation?.resources || !workshopSlug) return []

	const toLesson = (resource: {
		id: string
		type: string
		fields?: Record<string, any> | null
	}): CourseLesson[] =>
		LESSON_TYPES.has(resource.type) &&
		resource.fields?.slug &&
		resource.fields?.title &&
		isLive(resource.fields)
			? [
					{
						id: resource.id,
						slug: resource.fields.slug,
						title: resource.fields.title,
						type: resource.type,
						url: `${baseUrl}${lessonPath(workshopSlug, resource.fields.slug)}`,
					},
				]
			: []

	const sections: Array<{ title: string | null; lessons: CourseLesson[] }> = []
	for (const { resource } of navigation.resources) {
		if (resource.type === 'section') {
			if (!isLive(resource.fields)) continue
			sections.push({
				title: resource.fields?.title ?? null,
				lessons: (resource.resources ?? []).flatMap((child) =>
					toLesson(child.resource),
				),
			})
			continue
		}
		const lessons = toLesson(resource)
		if (lessons.length === 0) continue
		const last = sections.at(-1)
		if (last && last.title === null) last.lessons.push(...lessons)
		else sections.push({ title: null, lessons })
	}
	return sections.filter((section) => section.lessons.length > 0)
}

async function workshopStructure(
	workshop: {
		id: string
		slug: string
		title: string
		startsAt: string | null
	},
	baseUrl: string,
) {
	const navigation = await getCachedWorkshopNavigation(workshop.slug)
	return {
		id: workshop.id,
		slug: workshop.slug,
		title: workshop.title,
		url: `${baseUrl}${getResourcePath('workshop', workshop.slug)}`,
		opensAt: workshop.startsAt,
		sections: workshopSections(navigation, baseUrl),
	}
}

function parseOfficeHours(value: unknown) {
	let candidate = value
	if (typeof value === 'string') {
		try {
			candidate = JSON.parse(value)
		} catch {
			return []
		}
	}
	const parsed = CohortOfficeHoursSessionsSchema.safeParse(candidate)
	return parsed.success ? (parsed.data ?? []) : []
}

/**
 * Course content for the learner surface. No access checks here: the
 * package calls these only after the entitlements port says yes. Lesson
 * reads go through `sanitizeResourcePayload`, the agent-content read path
 * that strips Mux ids at every depth.
 */
export function makeContentPort({ baseUrl }: { baseUrl: string }): ContentPort {
	return {
		course: async (idOrSlug) => {
			const course = await getCourseResource(idOrSlug)
			if (!course) return null
			const ref = {
				id: course.id,
				slug: course.slug,
				title: course.title,
				type: course.type,
				url: `${baseUrl}${getResourcePath(course.type, course.slug)}`,
			}
			if (course.type === 'workshop') {
				return {
					course: ref,
					workshops: [await workshopStructure(course, baseUrl)],
				}
			}
			const navigation = await getCachedCohortNavigation(course.id)
			const workshops = await Promise.all(
				(navigation?.workshops ?? []).map((workshop) =>
					workshopStructure(workshop, baseUrl),
				),
			)
			return { course: ref, workshops }
		},

		lesson: async (locator) => {
			const lesson = await getLesson(locator.lesson)
			if (!lesson) return null
			const workshops = await getWorkshopsForLesson(lesson.id)
			const workshop =
				workshops.find(
					(candidate) =>
						candidate.id === locator.workshop ||
						candidate.fields?.slug === locator.workshop,
				) ?? workshops[0]
			const workshopSlug = workshop?.fields?.slug
			if (!workshop || !workshopSlug) return null

			const [transcript, sessionExtract, exercise] = await Promise.all([
				getLessonVideoTranscript(lesson.id),
				getLessonSessionExtract(lesson.id),
				getExerciseSolution(lesson.id),
			])
			const solution = exercise?.solution ?? null
			const lessonUrl = `${baseUrl}${lessonPath(workshopSlug, lesson.fields.slug)}`

			const content: LessonContent = {
				lesson: {
					id: lesson.id,
					slug: lesson.fields.slug,
					title: lesson.fields.title,
					type: lesson.type,
				},
				workshop: {
					id: workshop.id,
					slug: workshopSlug,
					title: workshop.fields?.title ?? workshopSlug,
				},
				body: lesson.fields.body ?? null,
				transcript: transcript ?? null,
				solution: solution
					? {
							title: solution.fields?.title ?? 'Solution',
							body: solution.fields?.body ?? null,
						}
					: null,
				sessionExtract,
				links: {
					lesson: lessonUrl,
					solution: solution ? `${lessonUrl}/solution` : null,
					workshop: `${baseUrl}${getResourcePath('workshop', workshopSlug)}`,
				},
			}
			return sanitizeResourcePayload(content) as LessonContent
		},

		officeHours: async (cohortId) => {
			const rows = await db
				.select({
					title: sql<
						string | null
					>`JSON_UNQUOTE(JSON_EXTRACT(${contentResource.fields}, '$.title'))`,
					sessions: sql<unknown>`JSON_EXTRACT(${contentResource.fields}, '$.officeHoursSessions')`,
				})
				.from(contentResource)
				.where(
					and(
						eq(contentResource.id, cohortId),
						eq(contentResource.type, 'cohort'),
						isNull(contentResource.deletedAt),
					),
				)
				.limit(1)
			const row = rows[0]
			if (!row) return null
			return {
				course: row.title ?? 'Cohort',
				sessions: parseOfficeHours(row.sessions).map((session) => ({
					title: session.title,
					startsAt: session.startsAt,
					endsAt: session.endsAt,
					youtubeWatchUrl: session.youtubeWatchUrl,
				})),
			}
		},
	}
}
