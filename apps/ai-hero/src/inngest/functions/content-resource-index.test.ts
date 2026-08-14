import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getContentResource: vi.fn(),
	upsertPostToTypeSense: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	createFunction: vi.fn(
		(config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: { getContentResource: mocks.getContentResource },
}))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: { createFunction: mocks.createFunction },
}))
vi.mock('@/lib/typesense-query', () => ({
	upsertPostToTypeSense: mocks.upsertPostToTypeSense,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))

import { contentResourceIndexRequested } from './content-resource-index'

type TestEvent = {
	data: { resourceId: string; committedVersionId: string }
}

type TestHandler = (input: {
	event: TestEvent
	step: {
		run: (id: string, callback: () => Promise<unknown>) => Promise<unknown>
	}
}) => Promise<unknown>

const registered = contentResourceIndexRequested as unknown as {
	config: { concurrency: { key: string; limit: number } }
	trigger: { event: string }
	handler: TestHandler
}

const latestResource = {
	id: 'workshop_1',
	type: 'workshop',
	createdById: 'owner_1',
	currentVersionId: 'version_2',
	fields: {
		title: 'Latest title',
		slug: 'stable-slug',
		state: 'published',
		visibility: 'public',
	},
	createdAt: new Date('2026-08-14T00:00:00.000Z'),
	updatedAt: new Date('2026-08-14T00:02:00.000Z'),
	deletedAt: null,
	resources: [],
	resourceProducts: [],
	organizationId: null,
	createdByOrganizationMembershipId: null,
}

const step = {
	run: vi.fn(async <T>(_id: string, callback: () => Promise<T>) => callback()),
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getContentResource.mockResolvedValue(latestResource)
	mocks.upsertPostToTypeSense.mockResolvedValue({ ok: true })
})

describe('content resource index requested', () => {
	it('registers keyed concurrency per resource', () => {
		expect(registered.config.concurrency).toEqual({
			key: 'event.data.resourceId',
			limit: 1,
		})
		expect(registered.trigger).toEqual({
			event: 'content/resource.index-requested',
		})
	})

	it('indexes the latest MySQL snapshot for reversed events', async () => {
		for (const committedVersionId of ['version_2', 'version_1']) {
			await registered.handler({
				event: {
					data: { resourceId: 'workshop_1', committedVersionId },
				},
				step,
			})
		}

		expect(mocks.getContentResource).toHaveBeenCalledTimes(2)
		expect(mocks.getContentResource).toHaveBeenNthCalledWith(1, 'workshop_1')
		expect(mocks.getContentResource).toHaveBeenNthCalledWith(2, 'workshop_1')
		expect(mocks.upsertPostToTypeSense).toHaveBeenCalledTimes(2)
		for (const [indexed, action] of mocks.upsertPostToTypeSense.mock.calls) {
			expect(indexed).toBe(latestResource)
			expect(indexed.currentVersionId).toBe('version_2')
			expect(action).toBe('save')
		}
	})
})
