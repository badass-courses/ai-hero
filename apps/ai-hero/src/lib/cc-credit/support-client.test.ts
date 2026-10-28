import { describe, expect, it, vi } from 'vitest'
import { verifySupportSignature } from '@/lib/support-signature'
import {
	deskCreditMode,
	postCreditRequest,
	supportCreditUrl,
} from './support-client'

describe('desk HMAC client', () => {
	it('maps every mutating desk action to a preview unless --apply is explicit', () => {
		expect(deskCreditMode('reserve')).toBe('inspect')
		expect(deskCreditMode('reconcile')).toBe('reconcile_preview')
		expect(deskCreditMode('backfill')).toBe('backfill_preview')
		for (const mode of ['reserve', 'reconcile', 'backfill'])
			expect(deskCreditMode(mode, true)).toBe(mode)
		expect(() => deskCreditMode('release')).toThrow()
	})
	it('signs exact request bytes with the support scheme and refuses redirects', async () => {
		const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
			expect(init?.redirect).toBe('error')
			expect(
				verifySupportSignature({
					bodyText: String(init?.body),
					signatureHeader: (init?.headers as Record<string, string>)[
						'x-support-signature'
					]!,
					webhookSecret: 'synthetic-secret',
				}),
			).toEqual({ valid: true })
			return new Response(JSON.stringify({ state: 'preview' }), { status: 200 })
		})
		expect(
			await postCreditRequest(
				'https://www.aihero.dev',
				{ mode: 'inspect' },
				'synthetic-secret',
				fetcher as typeof fetch,
			),
		).toMatchObject({ ok: true, result: { state: 'preview' } })
	})
	it('refuses previews and non-app hosts so signed private requests cannot be redirected elsewhere', () => {
		for (const origin of [
			'https://some-preview.vercel.app',
			'http://www.aihero.dev',
			'https://other.test',
			'https://user:pass@www.aihero.dev',
		])
			expect(() => supportCreditUrl(origin)).toThrow()
		expect(supportCreditUrl('http://127.0.0.1:3000')).toBe(
			'http://127.0.0.1:3000/api/support/cc-credit',
		)
	})
})
