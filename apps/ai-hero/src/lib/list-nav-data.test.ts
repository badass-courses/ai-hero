import { describe, expect, it } from 'vitest'

import { toListNavData } from './list-nav-data'

const lesson = (id: string, body?: string) => ({
	resourceId: id,
	resourceOfId: 'list-1',
	position: 0,
	metadata: {},
	createdAt: new Date(),
	updatedAt: new Date(),
	deletedAt: null,
	resource: {
		id,
		type: 'post',
		organizationId: 'org-1',
		createdById: 'user-1',
		fields: {
			slug: `${id}-slug`,
			title: `${id} title`,
			state: 'published',
			body: body ?? `# ${id}\n\na long markdown body`,
			description: 'a description nobody in the nav renders',
		},
	},
})

const list = {
	id: 'list-1',
	type: 'list',
	createdById: 'user-1',
	fields: {
		title: 'The List',
		slug: 'the-list',
		type: 'nextUp',
		state: 'published',
		visibility: 'public',
		body: 'the list landing body',
		description: 'the list description',
	},
	resources: [
		lesson('lesson-1'),
		{
			...lesson('section-1'),
			resource: {
				id: 'section-1',
				type: 'section',
				fields: { title: 'Section One' },
				resources: [lesson('lesson-2')],
			},
		},
	],
	tags: [{ tag: { id: 'tag-1', fields: { label: 'heavy tag row' } } }],
} as any

describe('toListNavData', () => {
	it('passes null through', () => {
		expect(toListNavData(null)).toBeNull()
	})

	it('keeps what the nav renders', () => {
		const nav = toListNavData(list)!

		expect(nav.id).toBe('list-1')
		expect(nav.fields.title).toBe('The List')
		expect(nav.fields.slug).toBe('the-list')

		const [first, section] = nav.resources
		expect(first.resource).toMatchObject({
			id: 'lesson-1',
			type: 'post',
			fields: {
				slug: 'lesson-1-slug',
				title: 'lesson-1 title',
				state: 'published',
			},
		})
		expect(first.resourceId).toBe('lesson-1')
		expect(first.position).toBe(0)

		expect(section.resource.type).toBe('section')
		expect(section.resource.fields.title).toBe('Section One')
		expect(section.resource.resources[0].resource.fields.slug).toBe(
			'lesson-2-slug',
		)
	})

	it('drops every body, description and tag from the payload', () => {
		const serialized = JSON.stringify(toListNavData(list))

		// The KEY, not just this fixture's sample values: an empty-string body
		// would sail past a value assertion.
		expect(serialized).not.toContain('"body"')
		expect(serialized).not.toContain('markdown body')
		expect(serialized).not.toContain('the list landing body')
		expect(serialized).not.toContain('description')
		expect(serialized).not.toContain('heavy tag row')
	})
})
