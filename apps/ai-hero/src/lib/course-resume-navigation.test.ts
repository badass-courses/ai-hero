import { describe, expect, it } from 'vitest'

import {
	getCourseLessons,
	getWorkshopResourceHref,
	getWorkshopStartHref,
	type CourseResource,
} from './course-resume-navigation'

const resource = (
	id: string,
	type: string,
	children: CourseResource[] = [],
): CourseResource => ({
	id,
	type,
	fields: { slug: id },
	resources: children.map((resource, position) => ({ resource, position })),
})

const lesson = resource('opening', 'lesson')
const nestedLesson = resource('practice', 'exercise')
const childLesson = resource('child-opening', 'lesson')
const childWorkshop = resource('child-workshop', 'workshop', [
	resource('child-section', 'section', [childLesson]),
])
const section = resource('concepts', 'section', [
	resource('nested-section', 'section', [lesson, nestedLesson]),
	childWorkshop,
])
const unknown = resource('future-resource', 'future-type', [
	resource('hidden-lesson', 'lesson'),
])
const tree = resource('parent-workshop', 'workshop', [section, unknown])

const realRoutes = new Set([
	'/workshops/parent-workshop',
	'/workshops/parent-workshop/opening',
	'/workshops/parent-workshop/practice',
	'/workshops/child-workshop',
	'/workshops/child-workshop/child-opening',
])

describe('typed workshop destinations', () => {
	it('resolves sections to their first playable child, never the section slug', () => {
		expect(getWorkshopResourceHref(tree, section)).toBe(
			'/workshops/parent-workshop/opening',
		)
		expect(getWorkshopStartHref(tree)).toBe(
			'/workshops/parent-workshop/opening',
		)
	})

	it('uses child workshop overviews and their own lesson parent', () => {
		expect(getWorkshopResourceHref(tree, childWorkshop)).toBe(
			'/workshops/child-workshop',
		)
		expect(getWorkshopResourceHref(tree, childLesson)).toBe(
			'/workshops/child-workshop/child-opening',
		)
		expect(getCourseLessons(tree).map(({ href }) => href)).toEqual([
			'/workshops/parent-workshop/opening',
			'/workshops/parent-workshop/practice',
			'/workshops/child-workshop/child-opening',
		])
	})

	it('generates only routes belonging to the fixture resource tree', () => {
		for (const item of [
			tree,
			section,
			lesson,
			nestedLesson,
			childWorkshop,
			childLesson,
		]) {
			expect(realRoutes.has(getWorkshopResourceHref(tree, item)!)).toBe(true)
		}
		for (const { href } of getCourseLessons(tree))
			expect(realRoutes.has(href)).toBe(true)
	})

	it('rejects unknown types, missing slugs, foreign and mistyped resources', () => {
		expect(getWorkshopResourceHref(tree, unknown)).toBeNull()
		expect(
			getWorkshopResourceHref(tree, resource('not-in-tree', 'lesson')),
		).toBeNull()
		expect(
			getWorkshopResourceHref(tree, { id: lesson.id, type: 'section' }),
		).toBeNull()
		const noSlug = { ...lesson, fields: {} }
		expect(
			getWorkshopResourceHref(resource('empty', 'workshop', [noSlug]), noSlug),
		).toBeNull()
		expect(
			getWorkshopResourceHref(resource('orphan', 'section', [lesson]), lesson),
		).toBeNull()
		expect(
			getWorkshopStartHref(resource('empty', 'workshop', [unknown])),
		).toBeNull()
	})

	it('skips empty sections and unknown resources and preserves position order', () => {
		const start = resource('start', 'workshop', [
			resource('empty', 'section'),
			unknown,
			lesson,
		])
		expect(getWorkshopStartHref(start)).toBe('/workshops/start/opening')
		expect(getCourseLessons(start).map(({ lesson }) => lesson.id)).toEqual([
			'opening',
		])
		start.resources!.reverse()
		expect(getWorkshopStartHref(start)).toBe('/workshops/start/opening')
	})

	it('resolves a section through a child workshop to its first real lesson', () => {
		const root = resource('root', 'workshop', [
			resource('group', 'section', [childWorkshop]),
		])
		expect(getWorkshopStartHref(root)).toBe(
			'/workshops/child-workshop/child-opening',
		)
		expect(getWorkshopResourceHref(root, childWorkshop)).toBe(
			'/workshops/child-workshop',
		)
	})
})
