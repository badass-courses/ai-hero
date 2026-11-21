import { createMongoAbility, type AnyMongoAbility } from '@casl/ability'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Contributor rules are createdById-conditioned, so a type-level
// ability.can('update', 'Content') passes for every contributor. These routes
// must check the loaded record, or require an admin (sec-034).

const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	getPage: vi.fn(),
	updateContentResourceFields: vi.fn(),
	getProduct: vi.fn(),
	updateProduct: vi.fn(),
	listAttendeesFor: vi.fn(),
	addAttendeeFor: vi.fn(),
	removeAttendeeFor: vi.fn(),
}))

vi.mock('@/db', () => ({
	db: {},
	courseBuilderAdapter: {
		updateContentResourceFields: mocks.updateContentResourceFields,
		getProduct: mocks.getProduct,
		updateProduct: mocks.updateProduct,
	},
}))
vi.mock('@/lib/pages-query', () => ({ getPage: mocks.getPage }))
vi.mock('@/lib/product-cache', () => ({ revalidateProducts: vi.fn() }))
vi.mock('@/lib/products-query', () => ({
	createProduct: vi.fn(),
	getProducts: vi.fn(),
	getProduct: vi.fn(),
}))
vi.mock('@/lib/cms/calendar-attendees-service', () => ({
	CalendarError: class extends Error {},
	listAttendeesFor: mocks.listAttendeesFor,
	addAttendeeFor: mocks.addAttendeeFor,
	removeAttendeeFor: mocks.removeAttendeeFor,
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.auth,
}))
vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('next/cache', () => ({ revalidateTag: vi.fn() }))

import { PUT as putProduct } from '@/app/api/(content)/products/route'
import {
	DELETE as deleteAttendee,
	GET as getAttendees,
	POST as postAttendee,
} from '@/app/api/calendar/attendees/route'
import { PUT as putPage } from '@/app/api/pages/route'

const contributor = createMongoAbility([
	{ action: 'manage', subject: 'Content', conditions: { createdById: 'u1' } },
	{ action: 'read', subject: 'Content' },
])
const admin = createMongoAbility([{ action: 'manage', subject: 'all' }])
const as = (ability: AnyMongoAbility) =>
	mocks.auth.mockResolvedValue({
		user: { id: 'u1' },
		ability,
		authMethod: 'session',
	})

const json = (url: string, method: string, body: unknown) =>
	new NextRequest(url, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})

const page = (createdById: string, state = 'draft') => ({
	id: 'page_1',
	type: 'page',
	createdById,
	fields: { slug: 'p', title: 'P', state, visibility: 'public' },
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.updateContentResourceFields.mockResolvedValue({ id: 'page_1' })
	mocks.getProduct.mockResolvedValue({
		id: 'product_1',
		name: 'Course',
		type: 'self-paced',
		quantityAvailable: -1,
		fields: { slug: 'course', state: 'published' },
		price: { unitAmount: 499 },
	})
	mocks.updateProduct.mockResolvedValue({ id: 'product_1' })
	mocks.listAttendeesFor.mockResolvedValue([])
})

describe('PUT /api/pages', () => {
	const put = (fields: Record<string, unknown>) =>
		putPage(json('http://localhost/api/pages?id=page_1', 'PUT', { fields }))

	it("refuses a contributor editing someone else's page", async () => {
		as(contributor)
		mocks.getPage.mockResolvedValue(page('someone-else'))
		const res = await put({ title: 'Mine now' })
		expect(res.status).toBe(403)
		expect(mocks.updateContentResourceFields).not.toHaveBeenCalled()
	})

	it("refuses a contributor publishing someone else's page", async () => {
		as(contributor)
		mocks.getPage.mockResolvedValue(page('someone-else'))
		const res = await put({ state: 'published' })
		expect(res.status).toBe(403)
	})

	it('lets a contributor edit their own page', async () => {
		as(contributor)
		mocks.getPage.mockResolvedValue(page('u1'))
		const res = await put({ title: 'Edited' })
		expect(res.status).toBe(200)
	})
})

describe('PUT /api/products', () => {
	const put = () =>
		putProduct(
			json('http://localhost/api/products', 'PUT', {
				id: 'product_1',
				price: 1,
			}),
		)

	it('refuses a contributor', async () => {
		as(contributor)
		const res = await put()
		expect(res.status).toBe(403)
		expect(mocks.updateProduct).not.toHaveBeenCalled()
	})

	it('refuses an admin-shaped check from a contributor even for state', async () => {
		as(contributor)
		const res = await putProduct(
			json('http://localhost/api/products', 'PUT', {
				id: 'product_1',
				fields: { state: 'archived' },
			}),
		)
		expect(res.status).toBe(403)
	})
})

describe('/api/calendar/attendees', () => {
	const url = 'http://localhost/api/calendar/attendees?slugOrId=event_1'

	it('refuses a contributor on every verb', async () => {
		as(contributor)
		const get = await getAttendees(new NextRequest(url))
		const post = await postAttendee(
			json(url, 'POST', { email: 'someone@example.com' }),
		)
		const del = await deleteAttendee(
			json(url, 'DELETE', { email: 'someone@example.com' }),
		)
		expect([get.status, post.status, del.status]).toEqual([403, 403, 403])
		expect(mocks.listAttendeesFor).not.toHaveBeenCalled()
		expect(mocks.addAttendeeFor).not.toHaveBeenCalled()
		expect(mocks.removeAttendeeFor).not.toHaveBeenCalled()
	})

	it('lets an admin list attendees', async () => {
		as(admin)
		const res = await getAttendees(new NextRequest(url))
		expect(res.status).not.toBe(403)
	})
})
