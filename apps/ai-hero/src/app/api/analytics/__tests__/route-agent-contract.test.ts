import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	getUserAbilityForRequest: vi.fn(),
	getServerAuthSession: vi.fn(),
	readMembers: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	catalog: [
		{
			name: 'revenue/promos',
			description: 'Promo revenue',
			category: 'revenue',
			provider: 'database',
			fn: 'getRevenueByPromo',
		},
		{
			name: 'funnel/evergreen',
			description: 'Pending evergreen funnel',
			category: 'attribution',
			provider: 'database',
			fn: 'getEvergreenFunnel',
		},
		{
			name: 'newsletter/signups',
			description: 'Newsletter signups from drovr',
			category: 'newsletter',
			provider: 'newsletter',
			fn: 'getNewsletterSignups',
		},
		{
			name: 'learning/progress',
			description: 'Aggregate learner progress',
			category: 'learning',
			provider: 'database',
			fn: 'getLearningProgress',
		},
		...(
			['learning/teams', 'learning/team', 'learning/team-members'] as const
		).map((name) => ({
			name,
			description: 'Team progress',
			category: 'learning',
			provider: 'database',
			fn: 'synthetic',
		})),
		...[
			'attribution/funnel',
			'attribution/coverage',
			'attribution/commerce-lanes',
		].map((name) => ({
			name,
			description: 'Synthetic attribution surface',
			category: 'attribution',
			provider: 'database',
			fn: 'synthetic',
		})),
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
vi.mock('@/lib/analytics/providers/database', () => ({
	readLearningTeamMembersUncached: mocks.readMembers,
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))

import { createAppAbility } from '@/ability'
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

	it.each(['revenue/promos', 'funnel/evergreen', 'newsletter/signups'])(
		'refuses signed-out and ordinary users for %s without querying',
		async (surface) => {
			for (const ability of [null, createAppAbility([])]) {
				mocks.getUserAbilityForRequest.mockResolvedValue({
					user: null,
					ability,
				})
				mocks.getServerAuthSession.mockResolvedValue({
					session: ability ? { user: { id: 'synthetic-non-admin' } } : null,
					ability,
				})
				const response = await GET(request(`?surface=${surface}`))
				expect(response.status).toBe(401)
				expect(mocks.query).not.toHaveBeenCalled()
			}
		},
	)

	it.each(['revenue/promos', 'funnel/evergreen'])(
		'accepts analytics-scoped device token for %s and preserves exact window',
		async (surface) => {
			mocks.getUserAbilityForRequest.mockResolvedValue({
				user: null,
				ability: createAppAbility([{ action: 'view', subject: 'Analytics' }]),
			})
			const data =
				surface === 'funnel/evergreen'
					? { status: 'pending', reason: 'Aggregate read pending' }
					: { currency: 'USD', byKind: [], daily: [] }
			mocks.query.mockResolvedValue({
				ok: true,
				data,
				meta: { queryTimeMs: 1, truncated: false },
			})
			const response = await GET(
				request(
					`?surface=${surface}&range=all&from=2026-01-01T18:00:00.001Z&to=2026-01-02T18:00:00Z`,
				),
			)
			expect(response.status).toBe(200)
			expect(mocks.query).toHaveBeenCalledWith(
				surface,
				expect.objectContaining({
					from: '2026-01-01T18:00:00.001Z',
					to: '2026-01-02T18:00:00Z',
				}),
			)
			const body = await response.json()
			expect(body.data).toEqual(data)
			expect(body.range).toBeUndefined()
			expect(body.window).toMatchObject({
				from: '2026-01-01T18:00:00.001Z',
				to: '2026-01-02T18:00:00.000Z',
				bounds: '[from,to)',
			})
			expect(body.window.basis).toBe(
				surface === 'revenue/promos' ? 'purchase-created' : undefined,
			)
			expect(body._links.self.href).toContain(
				'from=2026-01-01T18%3A00%3A00.001Z',
			)
			expect(JSON.stringify(body.data)).not.toMatch(
				/userId|purchaseId|couponId|email|userName/,
			)
		},
	)

	it('answers an unavailable drovr signup read with 503, not a count', async () => {
		mocks.query.mockResolvedValue({
			ok: false,
			surface: 'newsletter/signups',
			error: {
				code: 'SIGNUPS_UNAVAILABLE',
				message:
					'Newsletter signups are unavailable: drovr signup-counts read timed out.',
			},
			fix: 'Retry shortly. Unavailable is not zero; do not report a signup count.',
		})
		const response = await GET(request('?surface=newsletter/signups'))
		expect(response.status).toBe(503)
		const body = await response.json()
		expect(body).toMatchObject({
			ok: false,
			error: { code: 'SIGNUPS_UNAVAILABLE' },
		})
		expect(body.data).toBeUndefined()
	})

	it('reads 12 months of newsletter signups with range=365d', async () => {
		mocks.query.mockResolvedValue({
			ok: true,
			surface: 'newsletter/signups',
			range: '365d',
			data: { range: '365d' },
			meta: { queryTimeMs: 1, truncated: false },
		})
		const response = await GET(request('?surface=newsletter/signups&range=365d'))
		expect(response.status).toBe(200)
		expect(mocks.query).toHaveBeenCalledWith(
			'newsletter/signups',
			expect.objectContaining({ range: '365d' }),
		)
		const body = await response.json()
		expect(body.range).toBe('365d')
		for (const action of body.next_actions)
			expect(action.command).not.toContain('range=365d')
	})

	it('refuses range=365d for other surfaces without querying', async () => {
		const response = await GET(request('?surface=summary&range=365d'))
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({
			ok: false,
			error: { code: 'INVALID_RANGE_FOR_SURFACE' },
		})
		expect(mocks.query).not.toHaveBeenCalled()
	})

	it.each([null, 'ordinary'])(
		'refuses learning/progress for %s callers without querying',
		async (kind) => {
			const ability = kind ? createAppAbility([]) : null
			mocks.getUserAbilityForRequest.mockResolvedValue({ user: null, ability })
			mocks.getServerAuthSession.mockResolvedValue({
				session: ability ? { user: { id: 'synthetic-non-admin' } } : null,
				ability,
			})
			const response = await GET(
				request('?surface=learning/progress&productId=product-s00zs'),
			)
			expect(response.status).toBe(401)
			expect(mocks.query).not.toHaveBeenCalled()
		},
	)

	it('requires productId for learning/progress before querying', async () => {
		const response = await GET(request('?surface=learning/progress'))
		expect(response.status).toBe(400)
		expect((await response.json()).error.code).toBe('PRODUCT_REQUIRED')
		expect(mocks.query).not.toHaveBeenCalled()
	})

	it('serves learning/progress to the analytics token with its schema', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: null,
			ability: createAppAbility([{ action: 'view', subject: 'Analytics' }]),
		})
		const data = {
			asOf: '2026-10-29T12:00:00.000Z',
			funnel: {
				denominator: { basis: 'signed-in-learners', count: 4 },
				rows: [],
			},
		}
		mocks.query.mockResolvedValue({
			ok: true,
			data,
			meta: { queryTimeMs: 2, truncated: false },
		})
		const response = await GET(
			request('?surface=learning/progress&productId=product-s00zs'),
		)
		expect(response.status).toBe(200)
		expect(mocks.query).toHaveBeenCalledWith(
			'learning/progress',
			expect.objectContaining({ productId: 'product-s00zs' }),
		)
		const body = await response.json()
		expect(body).toMatchObject({
			ok: true,
			surface: 'learning/progress',
			productId: 'product-s00zs',
			data,
			schema: { requires: ['productId'] },
		})
		expect(body.agent_instructions).toEqual(
			expect.arrayContaining([
				expect.stringContaining('learning/progress requires productId'),
			]),
		)
	})

	it('answers an unknown learning product with 404', async () => {
		mocks.query.mockResolvedValue({
			ok: false,
			surface: 'learning/progress',
			error: { code: 'PRODUCT_NOT_FOUND', message: 'Unknown productId.' },
			fix: 'List product ids.',
		})
		const response = await GET(
			request('?surface=learning/progress&productId=missing'),
		)
		expect(response.status).toBe(404)
	})

	it.each(['learning/team', 'learning/team-members'])(
		'requires teamId for %s before querying',
		async (surface) => {
			const response = await GET(request(`?surface=${surface}`))
			expect(response.status).toBe(400)
			expect((await response.json()).error.code).toBe('TEAM_REQUIRED')
			expect(mocks.query).not.toHaveBeenCalled()
			expect(mocks.readMembers).not.toHaveBeenCalled()
		},
	)

	it('routes learning/team through the cached engine with teamId', async () => {
		mocks.query.mockResolvedValue({
			ok: true,
			data: { asOf: '2026-10-29T12:00:00.000Z' },
			meta: { queryTimeMs: 1, truncated: false },
		})
		const response = await GET(
			request('?surface=learning/team&teamId=bulk-coupon'),
		)
		expect(response.status).toBe(200)
		expect(mocks.query).toHaveBeenCalledWith(
			'learning/team',
			expect.objectContaining({ teamId: 'bulk-coupon' }),
		)
	})

	const memberData = {
		asOf: '2026-10-29T12:00:00.000Z',
		pii: true,
		team: {
			teamId: 'bulk-coupon',
			product: { id: 'synthetic-product', name: 'Synthetic' },
			seats: { bought: 5, redeemed: 2, unredeemed: 3 },
			organization: null,
		},
		members: [
			{
				userId: 'u-seat',
				email: 'learner@example.test',
				name: null,
				redeemedAt: '2026-10-01T00:00:00.000Z',
				signedIn: true,
				lastActiveAt: null,
				lessonsCompleted: 0,
				workshops: { started: 0, completed: 0, total: 4 },
			},
		],
	}

	it('refuses learning/team-members to an analytics-only role', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'analyst-1' },
			ability: createAppAbility([{ action: 'view', subject: 'Analytics' }]),
		})
		const response = await GET(
			request('?surface=learning/team-members&teamId=bulk-coupon'),
		)
		expect(response.status).toBe(403)
		expect((await response.json()).error.code).toBe('ADMIN_REQUIRED')
		expect(response.headers.get('cache-control')).toBe('private, no-store')
		expect(mocks.readMembers).not.toHaveBeenCalled()
		expect(mocks.query).not.toHaveBeenCalled()
		expect(mocks.log.warn).toHaveBeenCalledWith(
			'api.analytics.team-members.denied',
			{
				actorId: 'analyst-1',
				authMethod: 'device_token',
				teamId: 'bulk-coupon',
			},
		)
	})

	it('serves learning/team-members to an admin, uncached, and logs no member emails', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'admin-1', email: 'admin@example.test' },
			ability: createAppAbility([{ action: 'manage', subject: 'all' }]),
		})
		mocks.readMembers.mockResolvedValue(memberData)
		const response = await GET(
			request('?surface=learning/team-members&teamId=p-team'),
		)
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
		expect(response.headers.get('access-control-allow-origin')).toBeNull()
		expect(mocks.readMembers).toHaveBeenCalledWith('p-team', {
			includeUserIds: true,
		})
		// PII never flows through the engine or its caches.
		expect(mocks.query).not.toHaveBeenCalled()
		const body = await response.json()
		expect(body).toMatchObject({
			ok: true,
			surface: 'learning/team-members',
			pii: true,
			data: memberData,
			schema: { requires: ['teamId'], pii: true },
		})
		expect(mocks.log.info).toHaveBeenCalledWith(
			'api.analytics.team-members.read',
			{
				actorId: 'admin-1',
				authMethod: 'device_token',
				teamId: 'bulk-coupon',
				requestedTeamId: 'p-team',
				memberCount: 1,
			},
		)
		const logged = JSON.stringify([
			...mocks.log.info.mock.calls,
			...mocks.log.warn.mock.calls,
			...mocks.log.error.mock.calls,
		])
		expect(logged).not.toContain('learner@example.test')
	})

	it('answers an unknown team on learning/team-members with 404', async () => {
		const { LearningTeamNotFoundError } =
			await import('@/lib/analytics/learning-teams-query')
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'admin-1' },
			ability: createAppAbility([{ action: 'manage', subject: 'all' }]),
		})
		mocks.readMembers.mockRejectedValue(new LearningTeamNotFoundError())
		const response = await GET(
			request('?surface=learning/team-members&teamId=missing'),
		)
		expect(response.status).toBe(404)
		expect(response.headers.get('cache-control')).toBe('private, no-store')
	})

	it('rejects all on promo revenue with an actionable 400 prompt', async () => {
		const response = await GET(request('?surface=revenue/promos&range=all'))
		expect(response.status).toBe(400)
		expect((await response.json()).error.message).toContain(
			'Use range=24h,7d,30d,90d or paired from/to',
		)
		expect(mocks.query).not.toHaveBeenCalled()
	})

	it('rejects from/to on base surfaces instead of silently ignoring them', async () => {
		const response = await GET(
			request(
				'?surface=summary&from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z',
			),
		)
		expect(response.status).toBe(400)
		expect(mocks.query).not.toHaveBeenCalled()
	})

	it('rejects incomplete explicit windows before querying', async () => {
		const response = await GET(
			request('?surface=revenue/promos&from=2026-01-01T00:00:00Z'),
		)
		expect(response.status).toBe(400)
		expect(mocks.query).not.toHaveBeenCalled()
	})

	it('publishes both new schemas and their semantics', async () => {
		const body = await (await GET(request())).json()
		expect(body.surfaces.map((entry: { name: string }) => entry.name)).toEqual(
			expect.arrayContaining(['revenue/promos', 'funnel/evergreen']),
		)
		expect(body.schema.surfaces['revenue/promos']).toMatchObject({
			supports: ['range', 'from', 'to', 'productId'],
			data: {
				properties: {
					currency: { const: 'USD' },
					byKind: {
						items: {
							required: expect.arrayContaining([
								'gross',
								'refunds',
								'net',
								'currency',
								'recordCount',
							]),
						},
					},
				},
			},
		})
		expect(
			body.schema.surfaces['funnel/evergreen'].data.oneOf[0].properties.status
				.const,
		).toBe('pending')
		expect(body.schema.query.allOf[0].if.not).toEqual({
			required: ['from', 'to'],
		})
	})

	it('accepts the limited analytics-read device ability at the analytics route', async () => {
		mocks.getUserAbilityForRequest.mockResolvedValue({
			user: { id: 'user_1' },
			ability: createAppAbility([{ action: 'view', subject: 'Analytics' }]),
			authMethod: 'device-token',
		})

		const response = await GET(request())

		expect(response.status).toBe(200)
		expect((await response.json()).ok).toBe(true)
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
				version: '2026-11-01.2',
				query: {
					type: 'object',
					required: ['surface'],
					properties: {
						productId: { type: 'string' },
					},
					allOf: expect.arrayContaining([
						expect.objectContaining({
							then: { properties: { limit: { maximum: 1000 } } },
							else: { properties: { limit: { maximum: 100 } } },
						}),
					]),
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
						data: {
							items: {
								properties: {
									isTeam: {
										type: 'boolean',
										description: expect.stringContaining('bulk coupon'),
									},
									seats: {
										type: ['integer', 'null'],
										description: expect.stringContaining('add-seat teams'),
									},
									teamSeats: {
										type: ['integer', 'null'],
										description: expect.stringContaining('current total'),
									},
								},
							},
						},
						semantics: expect.arrayContaining([
							expect.stringContaining('teamSeats is the team total now'),
						]),
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
					{
						id: 'purchase_2',
						createdAt: '2026-08-18T12:00:00.000Z',
						isTeam: true,
						seats: null,
						teamSeats: 6,
					},
					{
						id: 'purchase_1',
						createdAt: '2026-08-18T11:00:00.000Z',
						isTeam: false,
						seats: null,
						teamSeats: null,
					},
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
		expect(
			body.data.map(
				({ isTeam, seats, teamSeats }: Record<string, unknown>) => ({
					isTeam,
					seats,
					teamSeats,
				}),
			),
		).toEqual([
			{ isTeam: true, seats: null, teamSeats: 6 },
			{ isTeam: false, seats: null, teamSeats: null },
		])
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

	it('does not advertise a next page when the exact final page is full', async () => {
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
				data: { totalRevenue: 398, purchaseCount: 2, avgOrderValue: 199 },
				meta: { queryTimeMs: 2, truncated: false },
			})

		const response = await GET(
			request('?surface=purchases/recent&range=7d&limit=2&offset=0'),
		)
		const body = await response.json()

		expect(body.meta.pagination.hasMore).toBe(false)
		expect(body.meta.pagination.nextOffset).toBeNull()
		expect(body._links.next).toBeUndefined()
		expect(
			body.next_actions.some(
				(action: { description: string }) =>
					action.description === 'Fetch the next page of purchases',
			),
		).toBe(false)
	})

	it('fails clearly when an exact purchase count is unavailable', async () => {
		mocks.query
			.mockResolvedValueOnce({
				ok: true,
				data: [{ id: 'purchase_1', createdAt: '2026-08-18T11:00:00.000Z' }],
				meta: { queryTimeMs: 5, truncated: false },
			})
			.mockResolvedValueOnce({
				ok: false,
				error: {
					code: 'DATABASE_UNAVAILABLE',
					message: 'Database unavailable',
				},
				fix: 'Retry later',
			})

		const response = await GET(
			request('?surface=purchases/recent&range=7d&limit=2&offset=0'),
		)
		const body = await response.json()

		expect(response.status).toBe(503)
		expect(body).toMatchObject({
			ok: false,
			surface: 'purchases/recent',
			error: { code: 'PURCHASE_COUNT_UNAVAILABLE' },
			fix: 'Retry later',
		})
	})
})
