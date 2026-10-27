import { db } from '@/db/client'
import { afterEach, expect, it, vi } from 'vitest'

const { createPool } = vi.hoisted(() => ({
	createPool: vi.fn(() => ({
		query: vi.fn(),
		getConnection: vi.fn(),
		end: vi.fn(),
	})),
}))
vi.mock('mysql2/promise', () => ({ default: { createPool } }))

afterEach(() => {
	vi.unstubAllEnvs()
})

it('supplies ambient DB configuration before static client imports', () => {
	expect(db).toBeDefined()
	expect(process.env.DATABASE_URL).toBe('mysql://test:test@127.0.0.1:1/mock_only')
	expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
		uri: process.env.DATABASE_URL,
	}))
})

it('restores the ambient fixture after per-test environment overrides', () => {
	vi.stubEnv('DATABASE_URL', 'mysql://override:override@127.0.0.1:1/mock_only')
	vi.unstubAllEnvs()
	expect(process.env.DATABASE_URL).toBe('mysql://test:test@127.0.0.1:1/mock_only')
})
