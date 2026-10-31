import { describe, expect, it } from 'vitest'

import type { ResourcePlanItem, SyncPlan } from './types'
import { undrawnImagesInPlan } from './undrawn-images'

const image = (hash: string) =>
	`https://res.cloudinary.com/total-typescript/image/upload/v1793300000/ai-hero-images/${hash}.png`

function item(
	action: ResourcePlanItem['action'],
	fields: Record<string, unknown>,
): ResourcePlanItem {
	return {
		sourceKind: 'lesson',
		sourceId: `lesson-${String(fields.title)}`,
		targetResourceId: `resource-${String(fields.title)}`,
		parentResourceId: 'section-1',
		position: 0,
		detached: false,
		previousDetached: false,
		previousParentResourceId: 'section-1',
		previousPosition: 0,
		action,
		fields,
		previousVersionId: null,
		previousFieldsSha256: null,
	}
}

function plan(resources: ResourcePlanItem[]): SyncPlan {
	return {
		bindingId: 'binding',
		sourceRevisionId: 'revision',
		courseVersionId: 'version',
		planSha256: 'sha',
		media: [],
		resources,
	}
}

describe('undrawnImagesInPlan', () => {
	it('lists each undrawn image once, under the first lesson that uses it', () => {
		expect(
			undrawnImagesInPlan(
				plan([
					item('create', { title: 'One', body: `![a](${image('aaaa')})` }),
					item('update', {
						title: 'Two',
						body: `![a](${image('aaaa')}) ![b](${image('bbbb')})`,
					}),
				]),
			),
		).toEqual([
			{ id: 'ai-hero-images/aaaa', url: image('aaaa'), title: 'One' },
			{ id: 'ai-hero-images/bbbb', url: image('bbbb'), title: 'Two' },
		])
	})

	it('skips lessons the source removed', () => {
		expect(
			undrawnImagesInPlan(
				plan([
					{
						...item('update', {
							title: 'Removed',
							body: `![a](${image('aaaa')})`,
						}),
						detached: true,
					},
				]),
			),
		).toEqual([])
	})

	it('skips retained lessons and resources without a body', () => {
		expect(
			undrawnImagesInPlan(
				plan([
					item('retain', { title: 'Old', body: `![a](${image('aaaa')})` }),
					item('update', { title: 'Section' }),
				]),
			),
		).toEqual([])
	})
})
