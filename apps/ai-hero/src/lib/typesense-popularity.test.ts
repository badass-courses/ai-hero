import { describe, expect, it, vi } from 'vitest'

import {
	buildPathIndex,
	computePopularityScores,
	normalizePath,
	writePopularityScores,
	type IndexablePopularityResource,
	type PopularityScore,
} from './typesense-popularity'

function resource(
	id: string,
	type: IndexablePopularityResource['type'],
	slug: string | null | undefined,
): IndexablePopularityResource {
	return {
		id,
		type,
		fields: slug === undefined ? null : { slug },
	}
}

describe('normalizePath', () => {
	it('strips trailing slash but keeps root', () => {
		expect(normalizePath('/foo/')).toBe('/foo')
		expect(normalizePath('/')).toBe('/')
	})

	it('drops query string', () => {
		expect(normalizePath('/foo?ref=x')).toBe('/foo')
	})

	it('drops hash fragment', () => {
		expect(normalizePath('/foo#bar')).toBe('/foo')
	})

	it('lowercases mixed case', () => {
		expect(normalizePath('/Foo/Bar')).toBe('/foo/bar')
	})

	it('handles compound noise (query + hash + trailing slash + case)', () => {
		expect(normalizePath('/Workshops/Bar/?utm=1#section')).toBe(
			'/workshops/bar',
		)
	})

	it('returns / for empty input', () => {
		expect(normalizePath('')).toBe('/')
	})
})

describe('buildPathIndex', () => {
	it('registers exact paths for post / event / list', () => {
		const idx = buildPathIndex([
			resource('post1', 'post', 'foo'),
			resource('event1', 'event', 'meet-up'),
			resource('list1', 'list', 'reading'),
		])
		expect(idx.exact.get('/foo')).toBe('post1')
		expect(idx.exact.get('/events/meet-up')).toBe('event1')
		expect(idx.exact.get('/reading')).toBe('list1')
		expect(idx.prefix).toHaveLength(0)
	})

	it('registers exact AND prefix for workshop', () => {
		const idx = buildPathIndex([resource('ws1', 'workshop', 'bar')])
		expect(idx.exact.get('/workshops/bar')).toBe('ws1')
		expect(idx.prefix).toContainEqual({
			prefix: '/workshops/bar/',
			resourceId: 'ws1',
		})
	})

	it('registers exact AND prefix for tutorial', () => {
		const idx = buildPathIndex([resource('tut1', 'tutorial', 'baz')])
		expect(idx.exact.get('/baz')).toBe('tut1')
		expect(idx.prefix).toContainEqual({
			prefix: '/baz/',
			resourceId: 'tut1',
		})
	})

	it('returns an empty index when given an empty list', () => {
		const idx = buildPathIndex([])
		expect(idx.exact.size).toBe(0)
		expect(idx.prefix).toHaveLength(0)
		expect(idx.resourceIds).toHaveLength(0)
	})

	it('skips resources whose slug is missing or non-string', () => {
		const idx = buildPathIndex([
			resource('post-missing', 'post', null),
			resource('post-empty', 'post', ''),
			{ id: 'post-no-fields', type: 'post', fields: null },
			resource('post-ok', 'post', 'real'),
		])
		expect(idx.exact.size).toBe(1)
		expect(idx.exact.get('/real')).toBe('post-ok')
		expect(idx.resourceIds).toEqual(['post-ok'])
	})

	it('skips resources of unknown type', () => {
		const idx = buildPathIndex([
			{
				id: 'weird',
				type: 'videoResource',
				fields: { slug: 'oops' },
			},
		])
		expect(idx.exact.size).toBe(0)
		expect(idx.prefix).toHaveLength(0)
		expect(idx.resourceIds).toHaveLength(0)
	})

	it('sorts prefix entries longest-first', () => {
		// Both workshops registered. Prefixes are sorted so the longer one is
		// tested first by computePopularityScores.
		const idx = buildPathIndex([
			resource('ws-short', 'workshop', 'a'),
			resource('ws-long', 'workshop', 'a-very-long-slug'),
		])
		expect(idx.prefix[0]?.prefix).toBe('/workshops/a-very-long-slug/')
	})
})

describe('computePopularityScores', () => {
	it('maps a normalized GA4 path through exact lookup', () => {
		const idx = buildPathIndex([resource('post1', 'post', 'foo')])
		const result = computePopularityScores(
			[{ path: '/foo', pageviews: 100 }],
			idx,
		)
		expect(result.scores).toEqual([{ id: 'post1', popularity_30d: 100 }])
		expect(result.mapped).toBe(1)
		expect(result.unmappedPaths).toHaveLength(0)
	})

	it('falls back to prefix match for workshop lesson paths', () => {
		const idx = buildPathIndex([resource('ws1', 'workshop', 'bar')])
		const result = computePopularityScores(
			[{ path: '/workshops/bar/lesson-1', pageviews: 50 }],
			idx,
		)
		expect(result.scores).toEqual([{ id: 'ws1', popularity_30d: 50 }])
	})

	it('chooses longest-prefix match when two prefixes apply', () => {
		// Hypothetical: a workshop with slug "a" and another "a/nested" registered
		// as plain workshop slug "a-nested-thing" — both prefixes match a path
		// like /workshops/a-nested-thing/foo. The longer prefix wins.
		const idx = buildPathIndex([
			resource('ws-short', 'workshop', 'a'),
			resource('ws-long', 'workshop', 'a-nested-thing'),
		])
		const result = computePopularityScores(
			[{ path: '/workshops/a-nested-thing/lesson-x', pageviews: 7 }],
			idx,
		)
		expect(result.scores).toContainEqual({
			id: 'ws-long',
			popularity_30d: 7,
		})
		expect(result.scores).not.toContainEqual({
			id: 'ws-short',
			popularity_30d: 7,
		})
	})

	it('sums pageviews when multiple GA4 rows resolve to the same resource', () => {
		const idx = buildPathIndex([resource('ws1', 'workshop', 'bar')])
		const result = computePopularityScores(
			[
				{ path: '/workshops/bar', pageviews: 10 },
				{ path: '/workshops/bar/lesson-1', pageviews: 20 },
				{ path: '/workshops/bar/lesson-2', pageviews: 30 },
				{ path: '/workshops/bar/lesson-3', pageviews: 40 },
				{ path: '/workshops/bar/lesson-4', pageviews: 50 },
			],
			idx,
		)
		expect(result.scores).toEqual([{ id: 'ws1', popularity_30d: 150 }])
		expect(result.mapped).toBe(5)
	})

	it('resets resources with zero matching paths', () => {
		const idx = buildPathIndex([
			resource('post1', 'post', 'foo'),
			resource('post2', 'post', 'unseen'),
		])
		const result = computePopularityScores(
			[{ path: '/foo', pageviews: 10 }],
			idx,
		)
		expect(result.scores).toEqual([
			{ id: 'post1', popularity_30d: 10 },
			{ id: 'post2', popularity_30d: 0 },
		])
	})

	it('maps list traffic from the public root slug path', () => {
		const idx = buildPathIndex([resource('list1', 'list', 'reading')])
		const result = computePopularityScores(
			[{ path: '/reading', pageviews: 15 }],
			idx,
		)
		expect(result.scores).toEqual([{ id: 'list1', popularity_30d: 15 }])
	})

	it('records unmapped GA4 paths for observability', () => {
		const idx = buildPathIndex([resource('post1', 'post', 'foo')])
		const result = computePopularityScores(
			[
				{ path: '/foo', pageviews: 5 },
				{ path: '/unknown-page', pageviews: 99 },
			],
			idx,
		)
		expect(result.unmappedPaths).toContain('/unknown-page')
		expect(result.mapped).toBe(1)
	})

	it('returns an empty result for empty GA4 input', () => {
		const idx = buildPathIndex([resource('post1', 'post', 'foo')])
		const result = computePopularityScores([], idx)
		expect(result).toEqual({
			scores: [{ id: 'post1', popularity_30d: 0 }],
			mapped: 0,
			unmappedPaths: [],
		})
	})

	it('score entries have exactly {id, popularity_30d} shape (invariant)', () => {
		const idx = buildPathIndex([
			resource('post1', 'post', 'foo'),
			resource('ws1', 'workshop', 'bar'),
		])
		const result = computePopularityScores(
			[
				{ path: '/foo', pageviews: 10, users: 4, avgDuration: 30 },
				{ path: '/workshops/bar/lesson-1', pageviews: 5 },
			],
			idx,
		)
		for (const score of result.scores) {
			expect(Object.keys(score).sort()).toEqual(['id', 'popularity_30d'])
		}
	})

	it('applies path normalization to GA4 rows (trailing slash + case)', () => {
		const idx = buildPathIndex([resource('post1', 'post', 'foo')])
		const result = computePopularityScores(
			[{ path: '/Foo/', pageviews: 12 }],
			idx,
		)
		expect(result.scores).toEqual([{ id: 'post1', popularity_30d: 12 }])
	})
})

describe('writePopularityScores', () => {
	function makeMockClient(returnValue: unknown) {
		const importMock = vi.fn().mockResolvedValue(returnValue)
		const documents = () => ({ import: importMock })
		const collections = vi.fn().mockReturnValue({ documents })
		return {
			client: { collections } as unknown as Parameters<
				typeof writePopularityScores
			>[0],
			importMock,
			collections,
		}
	}

	it('no-ops when scores is empty (does not call Typesense)', async () => {
		const { client, importMock } = makeMockClient([])
		const result = await writePopularityScores(client, 'col', [])
		expect(result).toEqual({ written: 0, failed: 0 })
		expect(importMock).not.toHaveBeenCalled()
	})

	it('passes scores verbatim to import with action: emplace', async () => {
		const { client, importMock, collections } = makeMockClient([
			{ success: true },
			{ success: true },
		])
		const scores: PopularityScore[] = [
			{ id: 'post1', popularity_30d: 100 },
			{ id: 'ws1', popularity_30d: 50 },
		]
		await writePopularityScores(client, 'content_production', scores)
		expect(collections).toHaveBeenCalledWith('content_production')
		expect(importMock).toHaveBeenCalledTimes(1)
		const [payload, opts] = importMock.mock.calls[0] ?? []
		expect(payload).toBe(scores) // identical reference — no transformation
		expect(opts).toEqual({ action: 'emplace' })
	})

	it('counts successes and failures from array response', async () => {
		const { client } = makeMockClient([
			{ success: true },
			{ success: false },
			{ success: true },
		])
		const result = await writePopularityScores(client, 'col', [
			{ id: 'a', popularity_30d: 1 },
			{ id: 'b', popularity_30d: 2 },
			{ id: 'c', popularity_30d: 3 },
		])
		expect(result).toEqual({ written: 2, failed: 1 })
	})

	it('counts successes and failures from JSONL string response', async () => {
		const { client } = makeMockClient(
			'{"success":true}\n{"success":false,"error":"x"}\n{"success":true}',
		)
		const result = await writePopularityScores(client, 'col', [
			{ id: 'a', popularity_30d: 1 },
			{ id: 'b', popularity_30d: 2 },
			{ id: 'c', popularity_30d: 3 },
		])
		expect(result).toEqual({ written: 2, failed: 1 })
	})
})
