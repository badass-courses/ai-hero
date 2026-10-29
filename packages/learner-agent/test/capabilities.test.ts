import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import { courseOutline } from '../src/capabilities/course-outline.js'
import { myCourses } from '../src/capabilities/my-courses.js'
import { officeHours } from '../src/capabilities/office-hours.js'
import { readLesson } from '../src/capabilities/read-lesson.js'
import { searchCourse } from '../src/capabilities/search-course.js'
import { sessionExtract } from '../src/capabilities/session-extract.js'
import type { Learner } from '../src/ports.js'
import { servicesFor } from '../src/services.js'
import {
	fakePorts,
	learner,
	otherLearner,
	refunded,
	type Recorder,
} from './fakes.js'

const as = (caller: Learner | null, recorder?: Recorder) =>
	Effect.provideContext(
		servicesFor(fakePorts(caller, recorder ? { recorder } : {})),
	)

const newRecorder = (): Recorder => ({ reads: [], rateLimitCalls: [] })

describe('my_courses', () => {
	it.effect(
		'asks an anonymous caller to sign in, with next actions that say how',
		() =>
			Effect.gen(function* () {
				const error = yield* myCourses.handler({}).pipe(Effect.flip, as(null))
				expect(error._tag).toBe('SignInRequired')
				expect(
					error.next_actions.map((action) => action.href ?? action.tool),
				).toEqual([
					'https://aihero.test/agents/connect',
					'https://aihero.test/oauth/device/code',
					'search_course',
				])
			}),
	)

	it.effect(
		'lists owned courses with open dates and points at each outline',
		() =>
			Effect.gen(function* () {
				const result = yield* myCourses.handler({}).pipe(as(learner))
				expect(result.courses.map((course) => course.slug)).toEqual([
					'ai-coding',
				])
				expect(result.courses[0]?.nextOpensAt).toBe('2099-01-01T00:00:00.000Z')
				expect(result.next_actions[0]).toMatchObject({
					tool: 'course_outline',
					arguments: { course: 'ai-coding' },
				})
			}),
	)

	it.effect('tells a learner who owns nothing where to look', () =>
		Effect.gen(function* () {
			const result = yield* myCourses.handler({}).pipe(as(refunded))
			expect(result.courses).toEqual([])
			expect(result.next_actions.length).toBeGreaterThan(0)
		}),
	)
})

describe('course_outline', () => {
	it.effect(
		'lists open lessons with completion and shows an embargoed workshop by title and date only',
		() =>
			Effect.gen(function* () {
				const recorder = newRecorder()
				const result = yield* courseOutline
					.handler({ course: 'ai-coding' })
					.pipe(as(learner, recorder))

				const [open, embargoed] = result.workshops
				expect(open?.access).toBe('open')
				expect(
					open?.sections[0]?.lessons.map((l) => [l.slug, l.completed]),
				).toEqual([
					['first-lesson', true],
					['second-lesson', false],
				])
				expect(embargoed).toMatchObject({
					access: 'not_yet_open',
					isOpen: false,
					title: 'Week Two',
					opensAt: '2099-01-01T00:00:00.000Z',
					sections: [],
				})
				expect(JSON.stringify(result)).not.toContain('locked-lesson')
				expect(result.progress).toEqual({ completed: 1, total: 2 })
				expect(result.next_actions[0]).toMatchObject({
					tool: 'read_lesson',
					arguments: { lesson: 'second-lesson', workshop: 'week-one' },
				})
				expect(
					result.next_actions.some(
						(a) => a.href === 'https://aihero.test/cohorts/ai-coding.md',
					),
				).toBe(true)
				expect(recorder.reads).toEqual([
					{
						userId: 'user-owner',
						capability: 'course_outline',
						resourceId: 'cohort-1',
					},
				])
			}),
	)

	it.effect('refuses a course the learner does not own', () =>
		Effect.gen(function* () {
			const error = yield* courseOutline
				.handler({ course: 'other' })
				.pipe(Effect.flip, as(learner))
			expect(error._tag).toBe('NotEntitled')
		}),
	)

	it.effect('refuses a refunded learner the course they no longer own', () =>
		Effect.gen(function* () {
			const error = yield* courseOutline
				.handler({ course: 'ai-coding' })
				.pipe(Effect.flip, as(refunded))
			expect(error._tag).toBe('NotEntitled')
		}),
	)

	it.effect('reports an unknown course as not found', () =>
		Effect.gen(function* () {
			const error = yield* courseOutline
				.handler({ course: 'nope' })
				.pipe(Effect.flip, as(learner))
			expect(error._tag).toBe('NotFound')
		}),
	)
})

describe('read_lesson', () => {
	it.effect(
		'returns the lesson, transcript and session extract, hides the solution, and logs the read',
		() =>
			Effect.gen(function* () {
				const recorder = newRecorder()
				const result = yield* readLesson
					.handler({
						lesson: 'first-lesson',
						workshop: 'week-one',
						includeSolution: false,
					})
					.pipe(as(learner, recorder))
				expect(result.body).toBe('Build the thing.')
				expect(result.transcript).toBe('Today we build the thing.')
				expect(result.sessionExtract?.sessions[0]?.entries).toHaveLength(4)
				expect(result.solutionAvailable).toBe(true)
				expect(result.solution).toBeNull()
				expect(
					result.next_actions.find((a) => a.arguments?.includeSolution === true)
						?.description,
				).toMatch(/only if the learner asks/i)
				expect(recorder.reads).toEqual([
					{
						userId: 'user-owner',
						capability: 'read_lesson',
						resourceId: 'lesson-1',
					},
				])
			}),
	)

	it.effect('returns the solution only when asked', () =>
		Effect.gen(function* () {
			const result = yield* readLesson
				.handler({ lesson: 'first-lesson', includeSolution: true })
				.pipe(as(learner))
			expect(result.solution?.body).toBe('Here is the answer.')
		}),
	)

	it.effect(
		'refuses an embargoed lesson with its open date and no content',
		() =>
			Effect.gen(function* () {
				const recorder = newRecorder()
				const error = yield* readLesson
					.handler({ lesson: 'locked-lesson', includeSolution: false })
					.pipe(Effect.flip, as(learner, recorder))
				expect(error).toMatchObject({
					_tag: 'NotYetOpen',
					title: 'Week Two',
					opensAt: '2099-01-01T00:00:00.000Z',
				})
				expect(recorder.reads).toEqual([])
			}),
	)

	it.effect.each([
		['a learner who does not own it', otherLearner],
		['a refunded learner', refunded],
	] as const)('refuses %s', ([, caller]) =>
		Effect.gen(function* () {
			const recorder = newRecorder()
			const error = yield* readLesson
				.handler({ lesson: 'first-lesson', includeSolution: false })
				.pipe(Effect.flip, as(caller, recorder))
			expect(error._tag).toBe('NotEntitled')
			expect(recorder.reads).toEqual([])
		}),
	)

	it.effect('refuses an anonymous caller', () =>
		Effect.gen(function* () {
			const error = yield* readLesson
				.handler({ lesson: 'first-lesson', includeSolution: false })
				.pipe(Effect.flip, as(null))
			expect(error._tag).toBe('SignInRequired')
		}),
	)
})

describe('session_extract', () => {
	it.effect('windows around a video second and names what was on screen', () =>
		Effect.gen(function* () {
			const result = yield* sessionExtract
				.handler({ lesson: 'first-lesson', atSeconds: 25, windowSeconds: 10 })
				.pipe(as(learner))
			expect(result.window).toEqual({
				atSeconds: 25,
				fromSeconds: 15,
				toSeconds: 35,
			})
			expect(result.onScreen).toMatchObject({
				kind: 'assistantText',
				visibleFrom: 20,
			})
			expect(
				result.extract?.sessions[0]?.entries.map((e) => e.visibleFrom),
			).toEqual([20])
			expect(result.entryCount).toBe(4)
		}),
	)

	it.effect(
		'keeps the on-screen entry even when it started before the window',
		() =>
			Effect.gen(function* () {
				const result = yield* sessionExtract
					.handler({
						lesson: 'first-lesson',
						atSeconds: 200,
						windowSeconds: 30,
					})
					.pipe(as(learner))
				expect(result.onScreen).toMatchObject({ visibleFrom: 20 })
				expect(
					result.extract?.sessions[0]?.entries.map((e) => e.visibleFrom),
				).toEqual([20])
			}),
	)

	it.effect(
		'pages on with the same window width, so no entries fall between',
		() =>
			Effect.gen(function* () {
				const result = yield* sessionExtract
					.handler({
						lesson: 'first-lesson',
						atSeconds: 600,
						windowSeconds: 300,
					})
					.pipe(as(learner))
				expect(result.window?.toSeconds).toBe(900)
				const next = result.next_actions.find(
					(action) => action.tool === 'session_extract',
				)
				expect(next?.arguments).toMatchObject({
					atSeconds: 1200,
					windowSeconds: 300,
				})
				// The next window starts where this one ends.
				const nextArgs = next?.arguments as {
					atSeconds: number
					windowSeconds: number
				}
				expect(nextArgs.atSeconds - nextArgs.windowSeconds).toBe(
					result.window?.toSeconds,
				)
			}),
	)

	it.effect('returns the whole extract without atSeconds', () =>
		Effect.gen(function* () {
			const result = yield* sessionExtract
				.handler({ lesson: 'first-lesson', windowSeconds: 90 })
				.pipe(as(learner))
			expect(result.window).toBeNull()
			expect(result.extract?.sessions[0]?.entries).toHaveLength(4)
		}),
	)
})

describe('search_course', () => {
	it.effect(
		'searches public content for an anonymous caller and says how to sign in',
		() =>
			Effect.gen(function* () {
				const result = yield* searchCourse
					.handler({ query: 'skills', limit: 5 })
					.pipe(as(null))
				expect(result.signedIn).toBe(false)
				expect(result.hits.every((hit) => !hit.readable)).toBe(true)
				expect(result.next_actions[0]?.href).toBe(
					'https://aihero.test/agents/connect',
				)
			}),
	)

	it.effect('marks lessons the learner can read and offers to open them', () =>
		Effect.gen(function* () {
			const result = yield* searchCourse
				.handler({ query: 'skills', limit: 5 })
				.pipe(as(learner))
			expect(result.hits.map((hit) => [hit.id, hit.readable])).toEqual([
				['lesson-2', true],
				['post-1', false],
			])
			expect(result.next_actions[0]).toMatchObject({
				tool: 'read_lesson',
				arguments: { lesson: 'second-lesson', workshop: 'week-one' },
			})
		}),
	)

	it.effect('never surfaces embargoed lessons as readable', () =>
		Effect.gen(function* () {
			const result = yield* searchCourse
				.handler({ query: 'locked', limit: 5 })
				.pipe(as(learner))
			expect(result.hits.some((hit) => hit.id === 'lesson-locked')).toBe(false)
		}),
	)
})

describe('office_hours', () => {
	it.effect(
		'lists upcoming sessions with weekday and UTC time, dropping past ones',
		() =>
			Effect.gen(function* () {
				yield* TestClock.setTime(Date.parse('2026-10-29T00:00:00.000Z'))
				const result = yield* officeHours.handler({}).pipe(as(learner))
				expect(result.sessions).toEqual([
					{
						course: 'AI Coding Crash Course',
						title: 'Office Hours',
						startsAt: '2099-03-05T17:00:00.000Z',
						endsAt: '2099-03-05T18:30:00.000Z',
						weekday: 'Thursday',
						time: '17:00 to 18:30 UTC',
						timezone: 'UTC',
						youtubeUrl: 'https://www.youtube.com/watch?v=next',
						status: 'upcoming',
					},
				])
			}),
	)

	it.effect('shows nothing for a learner with no cohort', () =>
		Effect.gen(function* () {
			const result = yield* officeHours.handler({}).pipe(as(refunded))
			expect(result.sessions).toEqual([])
		}),
	)
})
