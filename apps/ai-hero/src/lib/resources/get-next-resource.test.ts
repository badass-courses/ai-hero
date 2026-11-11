import { beforeEach, describe, expect, it, vi } from 'vitest'

const nav = vi.hoisted(() => ({ value: null as unknown }))
const lessons = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@/lib/workshops-query', () => ({
	getCachedWorkshopNavigation: vi.fn(async () => nav.value),
}))
vi.mock('@/lib/content-navigation', () => ({
	flattenNavigationResources: (n: { ids: string[] } | null) =>
		(n?.ids ?? []).map((id) => ({ id })),
}))
vi.mock('@/lib/lessons-query', () => ({
	getCachedLesson: vi.fn(async (id: string) => lessons.get(id) ?? null),
}))

import { getNextResource } from './get-next-resource'

describe('getNextResource', () => {
	beforeEach(() => {
		nav.value = { ids: ['l1', 's1', 'l2'] }
		lessons.clear()
		lessons.set('s1', {
			id: 's1',
			type: 'solution',
			fields: {
				slug: 'one-solution',
				body: 'PAID SOLUTION TEXT',
				state: 'draft',
			},
		})
		lessons.set('l2', {
			id: 'l2',
			type: 'lesson',
			fields: {
				slug: 'two',
				body: 'PAID LESSON TEXT',
				prompt: 'p',
				github: 'g',
			},
		})
	})

	it('returns only id, type and slug, never the body', async () => {
		const next = await getNextResource('l1', 'ws')
		expect(next).toEqual({
			id: 's1',
			type: 'solution',
			fields: { slug: 'one-solution' },
		})
		expect(JSON.stringify(next)).not.toContain('PAID')
	})

	it('finds the next resource after the first item', async () => {
		expect((await getNextResource('s1', 'ws'))?.fields.slug).toBe('two')
	})

	it('returns null for the last resource', async () => {
		expect(await getNextResource('l2', 'ws')).toBeNull()
	})

	it('returns null instead of throwing for an unknown id', async () => {
		await expect(
			getNextResource('sync_solution_does_not_exist', 'ws'),
		).resolves.toBeNull()
	})

	it('returns null for an unknown module', async () => {
		nav.value = null
		await expect(getNextResource('l1', 'nope')).resolves.toBeNull()
	})
})
