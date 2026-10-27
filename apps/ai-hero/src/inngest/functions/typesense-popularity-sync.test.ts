import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Errors } from 'typesense'

const mocks = vi.hoisted(() => ({
	importDocuments: vi.fn(),
	resources: vi.fn(),
	getTopPages: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/db', () => ({
	db: { query: { contentResource: { findMany: mocks.resources } } },
}))
vi.mock('@/lib/analytics/providers/ga4', () => ({
	getTopPages: mocks.getTopPages,
}))
vi.mock('@/server/logger', () => ({ log: mocks.log }))
vi.mock('../inngest.server', () => ({
	inngest: {
		createFunction: (_config: unknown, _trigger: unknown, handler: unknown) =>
			handler,
	},
}))
vi.mock('typesense', async (importOriginal) => {
	const actual = await importOriginal<typeof import('typesense')>()
	return {
		...actual,
		default: {
			...actual.default,
			Client: class {
				collections() {
					return { documents: () => ({ import: mocks.importDocuments }) }
				}
			},
		},
	}
})

import { typesensePopularitySync } from './typesense-popularity-sync'

const runSync = typesensePopularitySync as unknown as (input: {
	step: { run: <T>(name: string, callback: () => Promise<T>) => Promise<T> }
}) => Promise<unknown>
const step = {
	run: async <T>(_name: string, callback: () => Promise<T>) => callback(),
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.stubEnv('TYPESENSE_WRITE_API_KEY', 'test-write-key')
	vi.stubEnv('NEXT_PUBLIC_TYPESENSE_HOST', 'search.example.test')
	mocks.getTopPages.mockResolvedValue([{ path: '/example', pageviews: 42 }])
	mocks.resources.mockResolvedValue([
		{ id: 'a', type: 'post', fields: { slug: 'example' } },
		{ id: 'b', type: 'post', fields: { slug: 'missing' } },
	])
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('popularity sync write step', () => {
	it('completes with one count log when the SDK reports missing documents', async () => {
		mocks.importDocuments.mockRejectedValue(
			new Errors.ImportError('partial import', [
				{ success: true },
				{
					success: false,
					code: 404,
					error: 'Could not find a document with id: b',
				},
			]),
		)
		await expect(runSync({ step })).resolves.toMatchObject({
			writtenCount: 1,
			failedCount: 0,
			skippedCount: 1,
		})
		expect(mocks.importDocuments).toHaveBeenCalledWith(
			[
				{ id: 'a', popularity_30d: 42 },
				{ id: 'b', popularity_30d: 0 },
			],
			{ action: 'update' },
		)
		expect(
			mocks.log.info.mock.calls.filter(
				([event]) => event === 'typesense.popularity.sync.write.skipped',
			),
		).toEqual([
			[
				'typesense.popularity.sync.write.skipped',
				expect.objectContaining({ skippedCount: 1 }),
			],
		])
		expect(mocks.log.error).not.toHaveBeenCalled()
	})

	it('fails the step on a genuine per-document error, even alongside a 404', async () => {
		mocks.importDocuments.mockRejectedValue(
			new Errors.ImportError('partial import', [
				{ success: false, code: 400, error: 'Invalid field' },
				{
					success: false,
					code: 404,
					error: 'Could not find a document with id: b',
				},
			]),
		)
		await expect(runSync({ step })).rejects.toThrow('failed for 1 documents')
		expect(mocks.log.error).toHaveBeenCalledWith(
			'typesense.popularity.sync.write.failed',
			expect.any(Object),
		)
		expect(mocks.log.info).not.toHaveBeenCalledWith(
			'typesense.popularity.sync.complete',
			expect.any(Object),
		)
	})

	it('propagates transport failures unchanged', async () => {
		const error = new Error('Connection reset')
		mocks.importDocuments.mockRejectedValue(error)
		await expect(runSync({ step })).rejects.toBe(error)
	})
})
