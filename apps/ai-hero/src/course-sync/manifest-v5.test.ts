import { describe, expect, it } from 'vitest'
import {
	courseJsonVideos,
	decodeCourseJsonDocument,
} from '@ai-hero/course-sync-schema'
import { makeCourseJsonV3Fixture } from '../../../../packages/course-sync-schema/test/fixtures/course-json.v3'
import { makeCourseJsonV4SyllabusFixture } from '../../../../packages/course-sync-schema/test/fixtures/course-json.v4'
import { sourceResourceFields } from './control-plane'
import {
	mergeCourseSyncResourceFields,
	courseSyncSourceFields,
} from './resource-fields'
import { AI_HERO_COURSE_SYNC_BINDING } from './types'
import { resolveCourseSyncRollbackFields } from './persistence-invariants'

const text = {
	type: 'text',
	id: 'faq',
	title: 'FAQ',
	body: '## Question\nAnswer',
	description: 'Questions',
	optional: true,
}
function manifest(lesson: unknown = text, schemaVersion = 5) {
	return {
		...makeCourseJsonV4SyllabusFixture(),
		schemaVersion,
		sections: [
			{ id: 'before-we-start', title: 'Before We Start', lessons: [lesson] },
		],
	}
}

describe('course.json v5', () => {
	it('accepts v3/v4/v5 and every v4 document as v5', () => {
		for (const fixture of [
			makeCourseJsonV3Fixture(),
			makeCourseJsonV4SyllabusFixture(),
		]) {
			expect(decodeCourseJsonDocument(fixture)).toEqual(fixture)
			expect(
				decodeCourseJsonDocument({ ...fixture, schemaVersion: 5 }),
			).toEqual({ ...fixture, schemaVersion: 5 })
		}
	})
	it('creates a body-only text lesson, without media', () => {
		const doc = decodeCourseJsonDocument(manifest())
		expect(courseJsonVideos(doc)).toEqual([])
		const resources = sourceResourceFields(AI_HERO_COURSE_SYNC_BINDING, doc, [])
		expect(resources.map((item) => item.sourceKind)).toEqual([
			'section',
			'lesson',
		])
		expect(resources[1]?.fields).toMatchObject({
			body: text.body,
			description: text.description,
			optional: true,
			courseSync: { lessonType: 'text', videos: [], optionalOwnedBySync: true },
		})
	})
	it('writes false when optional is absent in v5', () => {
		const { optional, ...required } = text
		const resources = sourceResourceFields(
			AI_HERO_COURSE_SYNC_BINDING,
			decodeCourseJsonDocument(manifest(required)),
			[],
		)
		expect(resources[1]?.fields.optional).toBe(false)
		expect(
			mergeCourseSyncResourceFields(resources[1]!, { optional: true }).optional,
		).toBe(false)
	})
	it('preserves never-owned CMS optional values in v4 merges and comparisons', () => {
		const resources = sourceResourceFields(
			AI_HERO_COURSE_SYNC_BINDING,
			decodeCourseJsonDocument(
				manifest({ type: 'placeholder', id: 'faq', title: 'FAQ' }, 4),
			),
			[],
		)
		const lesson = resources[1]!
		expect(lesson.fields).not.toHaveProperty('optional')
		for (const optional of [true, false]) {
			const existing = { ...lesson.fields, optional }
			expect(courseSyncSourceFields('lesson', existing)).toEqual(lesson.fields)
			expect(mergeCourseSyncResourceFields(lesson, existing).optional).toBe(
				optional,
			)
		}
	})
	it('rolls the first v5 ownership claim back to the legacy value or absence', () => {
		for (const legacy of [{}, { optional: true }, { optional: false }]) {
			const restored = resolveCourseSyncRollbackFields({
				action: 'update',
				sourceKind: 'lesson',
				runId: 'run',
				currentFields: {
					optional: true,
					courseSync: { optionalOwnedBySync: true },
				},
				previousVersionFields: {
					...legacy,
					courseSync: { lessonType: 'placeholder' },
				},
			})
			expect(restored).toEqual({
				...legacy,
				courseSync: { lessonType: 'placeholder' },
			})
		}
	})

	it('accepts optional only as literal true on all four v5 lesson types', () => {
		const videoLesson = makeCourseJsonV3Fixture().sections[0]!.lessons[0]!
		const lessons = [
			text,
			{ type: 'placeholder', id: 'p', title: 'P' },
			videoLesson,
			{
				type: 'problem',
				id: 'problem',
				title: 'Problem',
				problem: videoLesson.explainer,
			},
		]
		for (const lesson of lessons) {
			expect(() =>
				decodeCourseJsonDocument(manifest({ ...lesson, optional: true })),
			).not.toThrow()
			for (const optional of [false, null, 'true', 1]) {
				expect(() =>
					decodeCourseJsonDocument(manifest({ ...lesson, optional })),
				).toThrow()
			}
			for (const version of [3, 4]) {
				expect(() =>
					decodeCourseJsonDocument(
						manifest({ ...lesson, optional: true }, version),
					),
				).toThrow()
			}
		}
	})
	it('rejects unknown types/keys and empty or absent text fields', () => {
		for (const lesson of [
			{ ...text, video: {} },
			{ ...text, type: 'article' },
			{ ...text, body: '' },
			{ ...text, description: '' },
			{ ...text, body: undefined },
			{ ...text, description: undefined },
		]) {
			expect(() => decodeCourseJsonDocument(manifest(lesson))).toThrow()
		}
		for (const version of [3, 4])
			expect(() => decodeCourseJsonDocument(manifest(text, version))).toThrow()
	})
})
