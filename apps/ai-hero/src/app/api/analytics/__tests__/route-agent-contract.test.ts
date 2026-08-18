import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	getServerAuthSession: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	catalog: [
		{
			name: 'summary',
			description: 'Revenue overview: total, purchase count, AOV',
			category: 'revenue',
			provider: 'database',
			fn: 'getRevenueSummary',
		},
		{
			name: 'revenue/daily',
			description: 'Revenue and purchase count per day',
			category: 'revenue',
			provider: 'database',
			fn: 'getRevenueByDay',
		},
		{
			name: 'revenue/products',
			description: 'Revenue grouped by product',
			category: 'revenue',
			provider: 'database',
			fn: 'getRevenueByProduct',
		},
		{
			name: 'purchases/recent',
			description: 'Last N purchases',
			category: 'revenue',
			provider: 'database',
			fn: 'getRecentPurchases',
		},
		{
			name: 'attribution/sources',
			description: 'Revenue by first-touch source/medium/campaign',
			category: 'attribution',
			provider: 'database',
			fn: 'getRevenueBySource',
		},
		{
			name: 'correlation/traffic-revenue',
			description: 'GA4 sessions + revenue by day',
			category: 'correlation',
			provider: 'derived',
			fn: 'getTrafficRevenueCorrelation',
		},
	],
}))

vi.mock('@/lib/analytics', () => ({
	getCatalog: () => mocks.catalog,
	query: mocks.query,
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: mocks.getUserAbilityForRequest,
}))
vi.mock('@/server/auth', () => ({
	getServerAuthSession: mocks.getServerAuthSession,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { GET } from '../route'

const request = (query = '') =>
	new NextRequest(`http://localhost:3000/api/analytics${query}`)

const analyticsAccess = {
	user: { id: 'user_1', email: 'team@example.com' },
	ability: { can: vi.fn(() => true) },
}

describe('analytics API agent contract', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getUserAbilityForRequest.mockResolvedValue(analyticsAccess)
		mocks.getServerAuthSession.mockResolvedValue({
			session: null,
			ability: null,
		})
	})

	it('publishes versioned query and revenue response schemas in the catalog', async () => {
		const response = await GET(request())
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({
			ok: true,
			agent_instructions: expect.arrayContaining([
				expect.stringContaining('same range and productId'),
				expect.stringContaining('data[].revenue'),
				expect.stringContaining('totalMatchingRows'),
				expect.stringContaining('_links.next.href'),
				expect.stringContaining('attribution surfaces also accept'),
				expect.stringContaining('defaults to range=30d'),
			]),
			schema: {
				version: '2026-08-18.1',
				query: {
					type: 'object',
					required: ['surface'],
					properties: {
						productId: { type: 'string' },
					},
					allOf: [
						{
							then: { properties: { limit: { maximum: 1000 } } },
							else: { properties: { limit: { maximum: 100 } } },
						},
					],
				},
				surfaces: {
					summary: {
						supports: ['range', 'productId'],
						data: {
							type: 'object',
							required: ['totalRevenue', 'purchaseCount', 'avgOrderValue'],
						},
					},
					'revenue/daily': {
						data: {
							type: 'array',
							items: {
								required: ['date', 'revenue', 'count'],
							},
						},
					},
					'purchases/recent': {
						supports: ['range', 'productId', 'limit', 'offset'],
						order: ['createdAt desc', 'id desc'],
						pagination: {
							limitMaximum: 100,
							totalMatchingCount: 'meta.pagination.totalMatchingRows',
							nextPage: '_links.next.href',
						},
					},
				},
			},
		})
	})

	it('returns the selected surface schema with the data', async () => {
		mocks.query.mockResolvedValue({
			ok: true,
			data: { totalRevenue: 398, purchaseCount: 2, avgOrderValue: 199 },
			meta: { queryTimeMs: 4, truncated: false },
		})

		const response = await GET(
			request('?surface=summary&range=24h&productId=product_crash'),
		)
		const body = await response.json()

		expect(body).toMatchObject({
			ok: true,
			surface: 'summary',
			range: '24h',
			productId: 'product_crash',
			schema: {
				supports: ['range', 'productId'],
				data: { type: 'object' },
			},
			_links: {
				self: {
					href: expect.stringContaining(
						'surface=summary&range=24h&limit=20&offset=0&productId=product_crash',
					),
				},
			},
		})
	})

	it('publishes pagination for recent purchases and preserves filters in the next action', async () => {
		mocks.query
			.mockResolvedValueOnce({
				ok: true,
				data: [
					{ id: 'purchase_2', createdAt: '2026-08-18T12:00:00.000Z' },
					{ id: 'purchase_1', createdAt: '2026-08-18T11:00:00.000Z' },
				],
				meta: { queryTimeMs: 5, truncated: false },
			})
			.mockResolvedValueOnce({
				ok: true,
				data: { totalRevenue: 995, purchaseCount: 5, avgOrderValue: 199 },
				meta: { queryTimeMs: 2, truncated: false },
			})

		const response = await GET(
			request(
				'?surface=purchases/recent&range=7d&productId=product_crash&limit=2&offset=0',
			),
		)
		const body = await response.json()

		expect(mocks.query).toHaveBeenNthCalledWith(2, 'summary', {
			range: '7d',
			productId: 'product_crash',
		})
		expect(body.meta.pagination).toEqual({
			limit: 2,
			offset: 0,
			returnedRows: 2,
			totalMatchingRows: 5,
			hasMore: true,
			nextOffset: 2,
			previousOffset: null,
		})
		expect(body._links).toMatchObject({
			self: {
				href: 'http://localhost:3000/api/analytics?surface=purchases%2Frecent&range=7d&limit=2&offset=0&productId=product_crash',
			},
			next: {
				href: 'http://localhost:3000/api/analytics?surface=purchases%2Frecent&range=7d&limit=2&offset=2&productId=product_crash',
			},
		})
		expect(body._links.previous).toBeUndefined()
		expect(body.next_actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					command:
						'GET /api/analytics?surface=purchases%2Frecent&range=7d&limit=2&offset=2&productId=product_crash',
				}),
			]),
		)
	})

	it('publishes a previous link and omits next on the last page', async () => {
		mocks.query
			.mockResolvedValueOnce({
				ok: true,
				data: [{ id: 'purchase_1', createdAt: '2026-08-18T11:00:00.000Z' }],
				meta: { queryTimeMs: 5, truncated: false },
			})
			.mockResolvedValueOnce({
				ok: true,
				data: { totalRevenue: 597, purchaseCount: 3, avgOrderValue: 199 },
				meta: { queryTimeMs: 2, truncated: false },
			})

		const response = await GET(
			request(
				'?surface=purchases/recent&range=7d&productId=product_crash&limit=2&offset=2',
			),
		)
		const body = await response.json()

		expect(body.meta.pagination).toEqual({
			limit: 2,
			offset: 2,
			returnedRows: 1,
			totalMatchingRows: 3,
			hasMore: false,
			nextOffset: null,
			previousOffset: 0,
		})
		expect(body._links.previous.href).toContain('offset=0')
		expect(body._links.next).toBeUndefined()
	})
})
