import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getUserAbilityForRequest: vi.fn(),
	addItemToList: vi.fn(),
	moveListItems: vi.fn(),
	removeItemFromList: vi.fn(),
	log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))

vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))

vi.mock('@/server/logger', async () => {
	const actual =
		await vi.importActual<typeof import('@/server/logger')>('@/server/logger')
	return { ...actual, log: mocks.log }
})

vi.mock('@/lib/lists/list-membership.service', async () => {
	const actual = await vi.importActual<
		typeof import('@/lib/lists/list-membership.service')
	>('@/lib/lists/list-membership.service')
	return {
		ListMembershipError: actual.ListMembershipError,
		addItemToList: mocks.addItemToList,
		moveListItems: mocks.moveListItems,
		removeItemFromList: mocks.removeItemFromList,
	}
})

import { ListMembershipError } from '@/lib/lists/list-membership.service'

import { DELETE, POST, PUT } from './route'

const context = { params: Promise.resolve({ listId: 'my-list' }) }

const request = (url: string, init?: RequestInit) =>
	new NextRequest(new Request(url, init))

const signedIn = () => {
	mocks.getUserAbilityForRequest.mockResolvedValue({
		user: { id: 'user-1' },
		ability: {},
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	mocks.getUserAbilityForRequest.mockResolvedValue({ user: null, ability: {} })
})

describe('POST /api/lists/[listId]/resources', () => {
	it('refuses an anonymous request before touching the list', async () => {
		const response = await POST(
			request('http://localhost:3000/api/lists/my-list/resources', {
				method: 'POST',
				body: JSON.stringify({ resourceId: 'post-1' }),
			}),
			context,
		)

		expect(response.status).toBe(401)
		expect(mocks.addItemToList).not.toHaveBeenCalled()
	})

	it('adds the resource and answers 201', async () => {
		signedIn()
		mocks.addItemToList.mockResolvedValue({ resourceId: 'post-1', position: 3 })

		const response = await POST(
			request('http://localhost:3000/api/lists/my-list/resources', {
				method: 'POST',
				body: JSON.stringify({ resourceId: 'post-1', parentId: 'section-1' }),
			}),
			context,
		)

		expect(response.status).toBe(201)
		expect(mocks.addItemToList).toHaveBeenCalledWith(
			expect.objectContaining({
				listIdOrSlug: 'my-list',
				data: { resourceId: 'post-1', parentId: 'section-1' },
			}),
		)
	})

	it('passes a service refusal through with its own status and code', async () => {
		// The service is where "already in this list" and "no such section" are
		// decided; the route must not flatten them into a 500.
		signedIn()
		mocks.addItemToList.mockRejectedValue(
			new ListMembershipError(
				'Resource is already in this list',
				409,
				'RESOURCE_ALREADY_IN_LIST',
			),
		)

		const response = await POST(
			request('http://localhost:3000/api/lists/my-list/resources', {
				method: 'POST',
				body: JSON.stringify({ resourceId: 'post-1' }),
			}),
			context,
		)

		expect(response.status).toBe(409)
		await expect(response.json()).resolves.toMatchObject({
			code: 'RESOURCE_ALREADY_IN_LIST',
		})
	})

	it('answers 500 for an unexpected failure without leaking it', async () => {
		signedIn()
		mocks.addItemToList.mockRejectedValue(new Error('connection reset'))

		const response = await POST(
			request('http://localhost:3000/api/lists/my-list/resources', {
				method: 'POST',
				body: JSON.stringify({ resourceId: 'post-1' }),
			}),
			context,
		)

		expect(response.status).toBe(500)
		await expect(response.json()).resolves.toEqual({
			code: 'INTERNAL_ERROR',
			error: 'Internal server error',
		})
	})
})

describe('PUT /api/lists/[listId]/resources', () => {
	it('hands the move batch to the service', async () => {
		signedIn()
		mocks.moveListItems.mockResolvedValue([])

		const items = [{ resourceId: 'post-1', parentId: 'section-1', position: 0 }]
		const response = await PUT(
			request('http://localhost:3000/api/lists/my-list/resources', {
				method: 'PUT',
				body: JSON.stringify({ items }),
			}),
			context,
		)

		expect(response.status).toBe(200)
		expect(mocks.moveListItems).toHaveBeenCalledWith(
			expect.objectContaining({ listIdOrSlug: 'my-list', data: { items } }),
		)
	})
})

describe('DELETE /api/lists/[listId]/resources', () => {
	it('requires the resourceId parameter', async () => {
		signedIn()

		const response = await DELETE(
			request('http://localhost:3000/api/lists/my-list/resources', {
				method: 'DELETE',
			}),
			context,
		)

		expect(response.status).toBe(400)
		expect(mocks.removeItemFromList).not.toHaveBeenCalled()
	})

	it('removes the named resource', async () => {
		signedIn()
		mocks.removeItemFromList.mockResolvedValue({
			resourceId: 'post-1',
			parentId: 'section-1',
			position: 0,
		})

		const response = await DELETE(
			request(
				'http://localhost:3000/api/lists/my-list/resources?resourceId=post-1',
				{ method: 'DELETE' },
			),
			context,
		)

		expect(response.status).toBe(200)
		expect(mocks.removeItemFromList).toHaveBeenCalledWith(
			expect.objectContaining({ listIdOrSlug: 'my-list', resourceId: 'post-1' }),
		)
	})
})
