import { Effect, Option, Schema } from 'effect'

import { defineContract, implement } from '../contract.js'
import { SearchHit, type CourseLesson } from '../domain.js'
import { Unavailable } from '../errors.js'
import { NextActions, nextTool } from '../next-actions.js'
import type { Learner } from '../ports.js'
import {
	Entitlements,
	LearnerContent,
	LearnerIdentity,
	LearnerSearch,
} from '../services.js'
import { signInActions } from './shared.js'

export const searchCourseContract = defineContract('search_course', {
	title: 'Search course',
	description:
		'Search AI Hero. Signed in, it also matches lesson titles in the open workshops the learner owns and marks which hits they can read now. Anonymous callers search public content.',
	input: Schema.Struct({
		query: Schema.String.check(
			Schema.isMinLength(1),
			Schema.isMaxLength(200),
		).annotate({
			description: 'What to find, in plain words.',
		}),
		limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))
			.annotate({ description: 'Maximum hits from each source. Default 5.' })
			.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
	}),
	output: Schema.Struct({
		query: Schema.String,
		signedIn: Schema.Boolean,
		hits: Schema.Array(SearchHit),
		next_actions: NextActions,
	}),
	failure: Unavailable,
	annotations: { readOnly: true, idempotent: true },
})

type ReadableLesson = CourseLesson & { readonly workshopSlug: string }

/** Lessons in the owned workshops that are open now. */
const readableLessons = (learner: Learner) =>
	Effect.gen(function* () {
		const entitlements = yield* Entitlements
		const content = yield* LearnerContent
		const courses = yield* entitlements.ownedCourses(learner)
		const structures = yield* Effect.forEach(
			courses,
			(course) => content.course(course.id),
			{ concurrency: 4 },
		)
		const lessons: ReadableLesson[] = []
		structures.forEach((structure, index) => {
			const owned = courses[index]
			if (!structure || !owned) return
			const open = new Set(
				owned.workshops
					.filter((workshop) => workshop.isOpen)
					.map((workshop) => workshop.id),
			)
			for (const workshop of structure.workshops) {
				if (!open.has(workshop.id)) continue
				for (const section of workshop.sections) {
					for (const lesson of section.lessons) {
						lessons.push({ ...lesson, workshopSlug: workshop.slug })
					}
				}
			}
		})
		return lessons
	})

const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? []

export const searchCourse = implement(
	searchCourseContract,
	({ query, limit }) =>
		Effect.gen(function* () {
			const identity = yield* LearnerIdentity
			const search = yield* LearnerSearch
			const publicHits = yield* search.search({ text: query, limit })

			if (Option.isNone(identity.current)) {
				return {
					query,
					signedIn: false,
					hits: publicHits.map((hit) => ({ ...hit, readable: false })),
					next_actions: yield* signInActions,
				}
			}

			const lessons = yield* readableLessons(identity.current.value)
			const byId = new Map(lessons.map((lesson) => [lesson.id, lesson]))
			const queryWords = words(query)
			const owned = lessons
				.filter((lesson) => {
					const title = words(lesson.title).join(' ')
					return queryWords.every((word) => title.includes(word))
				})
				.slice(0, limit)
			const ownedIds = new Set(owned.map((lesson) => lesson.id))

			const hits = [
				...owned.map((lesson) => ({
					id: lesson.id,
					type: lesson.type,
					title: lesson.title,
					url: lesson.url,
					summary: '',
					readable: true,
				})),
				...publicHits
					.filter((hit) => !ownedIds.has(hit.id))
					.map((hit) => ({ ...hit, readable: byId.has(hit.id) })),
			]

			return {
				query,
				signedIn: true,
				hits,
				next_actions: [
					...hits
						.flatMap((hit) => {
							const lesson = byId.get(hit.id)
							return lesson
								? [
										nextTool('read_lesson', `Read ${lesson.title}.`, {
											lesson: lesson.slug,
											workshop: lesson.workshopSlug,
										}),
									]
								: []
						})
						.slice(0, 3),
					nextTool('my_courses', 'List the courses this learner owns.'),
				],
			}
		}),
)
