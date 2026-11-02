import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/db/client', () => ({ acquireDatabaseConnection: vi.fn() }))
import {
	assertCreditWritesAllowed,
	creditEnabled,
	creditImportEnabled,
} from './runtime'
afterEach(() => {
	vi.unstubAllEnvs()
})
describe('CC credit enablement and preview fence', () => {
	it('defaults off and is always off on a Vercel preview', () => {
		vi.stubEnv('AIH_CC_CREDIT_ENABLED', '')
		expect(creditEnabled()).toBe(false)
		vi.stubEnv('AIH_CC_CREDIT_IMPORT_ENABLED', '')
		expect(creditImportEnabled()).toBe(false)
		vi.stubEnv('AIH_CC_CREDIT_IMPORT_ENABLED', '1')
		vi.stubEnv('AIH_CC_CREDIT_ENABLED', '1')
		vi.stubEnv('VERCEL_ENV', 'production')
		expect(creditEnabled()).toBe(true)
		vi.stubEnv('VERCEL_ENV', 'preview')
		expect(creditEnabled()).toBe(false)
		expect(creditImportEnabled()).toBe(false)
		expect(() => assertCreditWritesAllowed('sk_test_synthetic')).toThrow(
			'preview',
		)
	})
	it('refuses development writes with a live key or a remote database', () => {
		vi.stubEnv('VERCEL_ENV', 'development')
		vi.stubEnv(
			'DATABASE_URL',
			'mysql://synthetic:synthetic@127.0.0.1:4400/synthetic',
		)
		expect(() => assertCreditWritesAllowed('sk_live_synthetic')).toThrow()
		expect(() => assertCreditWritesAllowed('sk_test_synthetic')).not.toThrow()
		vi.stubEnv(
			'DATABASE_URL',
			'mysql://synthetic:synthetic@db.example.test/synthetic',
		)
		expect(() => assertCreditWritesAllowed('rk_test_synthetic')).toThrow()
	})
})
