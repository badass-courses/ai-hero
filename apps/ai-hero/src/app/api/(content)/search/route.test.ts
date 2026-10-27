import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { search, warn } = vi.hoisted(() => ({
	search: vi.fn(),
	warn: vi.fn(),
}))

vi.mock('typesense', () => ({
	default: {
		Client: class {
			collections() {
				return { documents: () => ({ search }) }
			}
		},
	},
}))
vi.mock('@/server/with-skill', () => ({
	withSkill: (handler: unknown) => handler,
}))
vi.mock('@/server/logger', () => ({
	log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@/server/ability-for-request', () => ({
	getUserAbilityForRequest: async () => ({ ability: {} }),
}))
vi.mock('@/lib/typesense-content-filter', () => ({
	buildTypesenseContentFilter: () => 'type:=post',
	isSearchContentType: () => true,
	searchContentTypes: ['post'],
}))
vi.mock('@/utils/resource-paths', () => ({
	getResourcePath: (_t: string, slug: string) => `/${slug}`,
}))

import { GET } from './route'

const okResult = {
	found: 1,
	search_time_ms: 3,
	hits: [{ document: { id: '1', type: 'post', title: 'T', slug: 's' } }],
}

const call = (qs: string) =>
	(GET as unknown as (r: NextRequest) => Promise<Response>)(
		new NextRequest(`https://example.com/api/search?${qs}`),
	)

const quotaError = () =>
	Object.assign(new Error('Request failed: account has no credits'), {
		name: 'RequestMalformed',
		httpStatus: 400,
	})

beforeEach(() => {
	vi.clearAllMocks()
	process.env.NEXT_PUBLIC_TYPESENSE_HOST = 'ts.example.com'
	process.env.TYPESENSE_WRITE_API_KEY = 'k'
})

describe('/api/search', () => {
	it('returns hybrid results with one search call', async () => {
		search.mockResolvedValueOnce(okResult)
		const res = await call('q=secret&semantic=true')
		const body = await res.json()
		expect(res.status).toBe(200)
		expect(body.result.mode).toBe('hybrid')
		expect(body.result.fallback).toBeUndefined()
		expect(search).toHaveBeenCalledTimes(1)
	})

	it('falls back to keyword when hybrid throws a quota error', async () => {
		search.mockRejectedValueOnce(quotaError()).mockResolvedValueOnce(okResult)
		const res = await call('q=secret-query&semantic=true&per_page=7')
		const body = await res.json()
		expect(res.status).toBe(200)
		expect(body.result.mode).toBe('keyword')
		expect(body.result.fallback).toEqual({
			from: 'hybrid',
			reason: 'embedding_provider_quota',
		})
		expect(search).toHaveBeenCalledTimes(2)
		const retry = search.mock.calls[1]![0]
		expect(retry.vector_query).toBeUndefined()
		expect(retry.prefix).toBeUndefined()
		expect(retry.query_by).toBe('title,summary,description')
		expect(retry.filter_by).toBe('type:=post')
		expect(retry.per_page).toBe(7)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith('search.semantic_fallback', {
			reason: 'embedding_provider_quota',
			errorName: 'RequestMalformed',
			httpStatus: 400,
		})
		expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-query')
	})

	it('returns 500 when hybrid and keyword both throw', async () => {
		search
			.mockRejectedValueOnce(new Error('boom'))
			.mockRejectedValueOnce(new Error('boom again'))
		const res = await call('q=x&semantic=true')
		const body = await res.json()
		expect(res.status).toBe(500)
		expect(body.error.code).toBe('SEARCH_ERROR')
		expect(search).toHaveBeenCalledTimes(2)
	})

	it('returns 500 without retry when a keyword request throws', async () => {
		search.mockRejectedValueOnce(new Error('boom'))
		const res = await call('q=x')
		expect(res.status).toBe(500)
		expect(search).toHaveBeenCalledTimes(1)
		expect(warn).not.toHaveBeenCalled()
	})
})
