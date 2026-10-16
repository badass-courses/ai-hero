import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	getProduct: vi.fn(),
	getSeatsTaken: vi.fn(),
}))
vi.mock('@/db', () => ({
	courseBuilderAdapter: { getProduct: mocks.getProduct },
}))
vi.mock('@/lib/seats-taken-query', async (importActual) => ({
	...(await importActual<typeof import('@/lib/seats-taken-query')>()),
	getSeatsTaken: mocks.getSeatsTaken,
}))
vi.mock('@/server/with-skill', () => ({ withSkill: (fn: unknown) => fn }))

import { GET } from './route'

const get = async () => {
	const response = await (GET as any)(
		new NextRequest('http://test.local/api/products/p1/availability'),
		{ params: Promise.resolve({ productId: 'p1' }) },
	)
	return { status: response.status, body: await response.json() }
}

describe('availability route', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('reports cap minus seats taken', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: 10 })
		mocks.getSeatsTaken.mockResolvedValue(4)
		expect((await get()).body).toEqual({
			quantityAvailable: 6,
			unlimited: false,
		})
	})

	it('reports 0, never -1, when seats taken passes the cap', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: 10 })
		mocks.getSeatsTaken.mockResolvedValue(11)
		expect((await get()).body).toEqual({
			quantityAvailable: 0,
			unlimited: false,
		})
	})

	it('leaves unlimited products alone and skips the seat query', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: -1 })
		expect((await get()).body).toEqual({
			quantityAvailable: -1,
			unlimited: true,
		})
		expect(mocks.getSeatsTaken).not.toHaveBeenCalled()
	})

	it('fails closed when the seat query fails', async () => {
		mocks.getProduct.mockResolvedValue({ quantityAvailable: 10 })
		mocks.getSeatsTaken.mockRejectedValue(new Error('no usable total'))
		expect((await get()).status).toBe(500)
	})
})
