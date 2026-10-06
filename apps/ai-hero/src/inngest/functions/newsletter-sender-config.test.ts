import { describe, expect, it } from 'vitest'
import { parseNewsletterSenderConfig } from './newsletter-sender-config'

const base = {
	pacingMs: undefined,
	limit: undefined,
	inheritLimit: () => 25,
	inheritPacingMs: () => 10_000,
}

describe('newsletter opt-in configuration', () => {
	it('both unset disables ALL new behavior without evaluating inheritance', () => {
		expect(parseNewsletterSenderConfig({ ...base,
			inheritLimit: () => { throw new Error('must not evaluate') },
			inheritPacingMs: () => { throw new Error('must not evaluate') },
		})).toEqual({ mode: 'legacy' })
	})
	it('only pacing activates the pause and inherits the current limit', () => {
		expect(parseNewsletterSenderConfig({ ...base, pacingMs: '2000' })).toEqual({ mode: 'opt-in', pacingMs: 2000, limit: 25 })
	})
	it('only limit activates the pause and preserves inherited pacing, including zero', () => {
		for (const inherited of [0, 3000, 5000]) {
			expect(parseNewsletterSenderConfig({ ...base, limit: '120', inheritPacingMs: () => inherited })).toEqual({ mode: 'opt-in', pacingMs: inherited, limit: 120 })
		}
	})
	it('both explicit use only dedicated values, never old parser fallbacks', () => {
		expect(parseNewsletterSenderConfig({ ...base, limit: ' 120 ', pacingMs: '2000',
			inheritLimit: () => { throw new Error('unused') }, inheritPacingMs: () => { throw new Error('unused') },
		})).toEqual({ mode: 'opt-in', pacingMs: 2000, limit: 120 })
	})
	it('bounds the sum of inter-row sleeps at600s, with a200s route margin', () => {
		expect(parseNewsletterSenderConfig({ ...base, limit: '11', pacingMs: '60000' })).toEqual({ mode: 'opt-in', limit: 11, pacingMs: 60000 })
		expect(() => parseNewsletterSenderConfig({ ...base, limit: '12', pacingMs: '60000' })).toThrow('batch pacing exceeds')
		expect(() => parseNewsletterSenderConfig({ ...base, limit: '120', pacingMs: '10000' })).toThrow('batch pacing exceeds')
		expect(() => parseNewsletterSenderConfig({ ...base, limit: '120' })).toThrow('batch pacing exceeds')
		expect(parseNewsletterSenderConfig({ ...base, limit: '1', pacingMs: '60000' })).toEqual({ mode: 'opt-in', limit: 1, pacingMs: 60000 })
	})
	it('refuses inherited limit above120 on partial opt-in, without clamping', () => {
		expect(() => parseNewsletterSenderConfig({ ...base, pacingMs: '2000', inheritLimit: () => 220 })).toThrow('Set AIH_DROVR_NEWSLETTER_LIMIT explicitly')
	})
	it.each(['', ' ', '0', '-1', '+2', '1.5', '01', '1e2', '120rows', '121', '9007199254740992'])(
		'refuses explicit malformed/out-of-cap LIMIT %j', value => {
			expect(() => parseNewsletterSenderConfig({ ...base, limit: value })).toThrow('AIH_DROVR_NEWSLETTER_LIMIT')
		},
	)
	it.each(['', ' ', '0', '-1', '+2000', '1999', '2000.5', '02000', '2e3', '2000ms', '60001', '9007199254740992'])(
		'refuses explicit malformed/out-of-range PACING %j', value => {
			expect(() => parseNewsletterSenderConfig({ ...base, pacingMs: value })).toThrow('AIH_DROVR_NEWSLETTER_PACING_MS')
		},
	)
	it('makes inherited parser failure visible and rejects unusable inherited pacing', () => {
		expect(() => parseNewsletterSenderConfig({ ...base, limit: '120', inheritPacingMs: () => { throw new Error('old parser') } })).toThrow('inherited configuration is invalid')
		for (const value of [-1, NaN, Infinity, 1.5]) expect(() => parseNewsletterSenderConfig({ ...base, limit: '120', inheritPacingMs: () => value })).toThrow('inherited pacing is invalid')
	})
})
