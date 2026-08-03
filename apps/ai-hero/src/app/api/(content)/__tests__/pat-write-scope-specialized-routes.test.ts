import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	addTagToPost: vi.fn(),
	createShortlink: vi.fn(),
	getContentResource: vi.fn(),
	getPage: vi.fn(),
	getShortlinks: vi.fn(),
	getTags: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
	removeTagFromPost: vi.fn(),
	updateContentResourceFields: vi.fn(),
}))

vi.mock('@/db', () => ({
	courseBuilderAdapter: {
		getContentResource: mocks.getContentResource,
		updateContentResourceFields: mocks.updateContentResourceFields,
	},
}))
vi.mock('@/lib/pages-query', () => ({ getPage: mocks.getPage }))
vi.mock('@/lib/posts-query', () => ({
	addTagToPost: mocks.addTagToPost,
	removeTagFromPost: mocks.removeTagFromPost,
}))
vi.mock('@/lib/tags-query', () => ({ getTags: mocks.getTags }))
vi.mock('@/lib/shortlinks-query', () => ({
	createShortlink: mocks.createShortlink,
	deleteShortlink: vi.fn(),
	getRecentClickStats: vi.fn(),
	getShortlinkAnalytics: vi.fn(),
	getShortlinkById: vi.fn(),
	getShortlinks: mocks.getShortlinks,
	updateShortlink: vi.fn(),
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))

import { POST as attachTag } from '@/app/api/(content)/tags/attach/route'
import { PUT as updatePage } from '@/app/api/pages/route'
import {
	GET as getShortlinks,
	POST as createShortlink,
} from '@/app/api/shortlinks/route'
import { buildPersonalAccessTokenAbility } from '@/server/pat-scopes'

const user = { id: 'user_1', email: 'agent@example.com' }
const patAuth = (scopes: string[]) => ({
	user,
	ability: buildPersonalAccessTokenAbility(scopes),
	authMethod: 'personal-access-token' as const,
})

const jsonRequest = (url: string, method: string, body: unknown) =>
	new NextRequest(url, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

describe('specialized PAT write scope routes', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getContentResource.mockResolvedValue({ id: 'post_1', type: 'post' })
		mocks.getPage.mockResolvedValue({
			id: 'page_1',
			fields: { slug: 'page', state: 'draft' },
		})
		mocks.updateContentResourceFields.mockResolvedValue({ id: 'page_1' })
		mocks.getTags.mockResolvedValue([{ id: 'tag_1' }])
		mocks.createShortlink.mockResolvedValue({
			id: 'shortlink_1',
			slug: 'scoped',
			url: 'https://www.aihero.dev',
			clicks: 42,
		})
		mocks.getShortlinks.mockResolvedValue([
			{
				id: 'shortlink_1',
				slug: 'scoped',
				url: 'https://www.aihero.dev',
				clicks: 42,
			},
		])
	})

	it('lets content:relations attach a tag but rejects a sibling scope', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(
			patAuth(['content:relations']),
		)
		const allowed = await attachTag(
			jsonRequest('http://localhost:3000/api/tags/attach', 'POST', {
				postId: 'post_1',
				tagId: 'tag_1',
			}),
		)

		mocks.getUserAbilityForRequest.mockResolvedValue(
			patAuth(['shortlinks:manage']),
		)
		const denied = await attachTag(
			jsonRequest('http://localhost:3000/api/tags/attach', 'POST', {
				postId: 'post_1',
				tagId: 'tag_1',
			}),
		)

		expect(allowed.status).toBe(200)
		expect(denied.status).toBe(403)
		expect(mocks.addTagToPost).toHaveBeenCalledOnce()
	})

	it('never attaches tags to hard-excluded resource types', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(
			patAuth(['content:relations']),
		)
		mocks.getContentResource.mockResolvedValue({
			id: 'survey_1',
			type: 'survey',
		})

		const response = await attachTag(
			jsonRequest('http://localhost:3000/api/tags/attach', 'POST', {
				postId: 'survey_1',
				tagId: 'tag_1',
			}),
		)

		expect(response.status).toBe(404)
		expect(mocks.addTagToPost).not.toHaveBeenCalled()
	})

	it('lets shortlinks:manage create and list links but not read analytics', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(
			patAuth(['shortlinks:manage']),
		)

		const created = await createShortlink(
			jsonRequest('http://localhost:3000/api/shortlinks', 'POST', {
				url: 'https://www.aihero.dev',
				description: 'Scoped link',
			}),
		)
		const listed = await getShortlinks(
			new NextRequest('http://localhost:3000/api/shortlinks'),
		)
		const analytics = await getShortlinks(
			new NextRequest('http://localhost:3000/api/shortlinks?analytics=recent'),
		)

		expect(created.status).toBe(201)
		expect(await created.json()).not.toHaveProperty('clicks')
		expect(listed.status).toBe(200)
		expect(await listed.json()).toEqual([
			{
				id: 'shortlink_1',
				slug: 'scoped',
				url: 'https://www.aihero.dev',
			},
		])
		expect(analytics.status).toBe(403)
	})

	it('lets content:write edit draft pages but not published pages', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(patAuth(['content:write']))

		const draftResponse = await updatePage(
			jsonRequest('http://localhost:3000/api/pages?id=page_1', 'PUT', {
				fields: { title: 'Draft page' },
			}),
		)
		mocks.getPage.mockResolvedValue({
			id: 'page_1',
			fields: { slug: 'page', state: 'published' },
		})
		const publishedResponse = await updatePage(
			jsonRequest('http://localhost:3000/api/pages?id=page_1', 'PUT', {
				fields: { title: 'Live page' },
			}),
		)
		const unpublishResponse = await updatePage(
			jsonRequest('http://localhost:3000/api/pages?id=page_1', 'PUT', {
				fields: { state: 'draft' },
			}),
		)

		expect(draftResponse.status).toBe(200)
		expect(publishedResponse.status).toBe(403)
		expect(unpublishResponse.status).toBe(403)
	})

	it('rejects content:relations on shortlink mutation routes', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue(
			patAuth(['content:relations']),
		)

		const response = await createShortlink(
			jsonRequest('http://localhost:3000/api/shortlinks', 'POST', {
				url: 'https://www.aihero.dev',
			}),
		)

		expect(response.status).toBe(403)
		expect(mocks.createShortlink).not.toHaveBeenCalled()
	})
})
