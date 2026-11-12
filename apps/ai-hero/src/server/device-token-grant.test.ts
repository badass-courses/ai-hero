import { describe, expect, it, vi } from 'vitest'
vi.mock('@/db', () => ({ db: {} }))
import { seal, unseal } from '@/lib/learner-agent/oauth/sealed'
import {
	deviceGrantFromCode,
	mintDeviceCode,
	mintDeviceConsent,
	matchesDeviceConsent,
	requestedDeviceGrant,
} from './device-token-grant'

describe('device grant binding', () => {
	it.each([undefined, '', 'unknown', 'aihero-cli'])(
		'defaults %s to learner reads',
		(client) => {
			expect(requestedDeviceGrant(client, undefined)?.scope).toBe(
				'learner:read',
			)
		},
	)
	it.each([undefined, 'unknown', 'learner-device'])(
		'cannot grant admin to %s',
		(client) => {
			expect(requestedDeviceGrant(client, 'admin:all')).toBeNull()
		},
	)
	it.each(['learner:read', 'admin:all'] as const)(
		'binds %s in fewer than 191 characters',
		(scope) => {
			const grant = { clientName: 'aihero-cli' as const, scope }
			const code = mintDeviceCode(grant)!
			expect(code.length).toBeLessThanOrEqual(191)
			expect(deviceGrantFromCode(code)).toEqual(grant)
			expect(mintDeviceCode(grant)).not.toBe(code)
			const raw = Buffer.from(code.slice('aih_dev_'.length), 'base64url')
			raw[raw.length - 1] = raw[raw.length - 1]! ^ 1
			expect(
				deviceGrantFromCode(`aih_dev_${raw.toString('base64url')}`),
			).toBeNull()
		},
	)
	it.each([
		{ c: 'unknown', s: 'admin:all' },
		{ c: 'learner-device', s: 'admin:all' },
		{ c: 'aihero-cli', s: 'unknown' },
	])(
		'refuses an invalid client/scope payload even with a valid seal: %j',
		(payload) => {
			expect(
				deviceGrantFromCode(`aih_dev_${seal('device', payload)}`),
			).toBeNull()
		},
	)
	it('binds consent to the shown grant and user without disclosing its polling secret', () => {
		const code = mintDeviceCode({
			clientName: 'aihero-cli',
			scope: 'admin:all',
		})!
		const consent = mintDeviceConsent('user-code', code, 'u1')!
		expect(matchesDeviceConsent(consent, 'user-code', code, 'u1')).toBe(true)
		expect(matchesDeviceConsent(consent, 'other-code', code, 'u1')).toBe(false)
		expect(matchesDeviceConsent(consent, 'user-code', code, 'u2')).toBe(false)
		const other = mintDeviceCode({
			clientName: 'learner-device',
			scope: 'learner:read',
		})!
		expect(matchesDeviceConsent(consent, 'user-code', other, 'u1')).toBe(false)
		expect(deviceGrantFromCode(consent)).toBeNull()
		const payload = unseal('device-consent', consent) as Record<string, unknown>
		expect(JSON.stringify(payload)).not.toContain(code)
		expect(payload.d).toMatch(/^[a-f0-9]{64}$/)
		expect(
			matchesDeviceConsent(
				seal('device-consent', { ...payload, s: 'learner:read' })!,
				'user-code',
				code,
				'u1',
			),
		).toBe(false)
		expect(
			matchesDeviceConsent(seal('consent', payload)!, 'user-code', code, 'u1'),
		).toBe(false)
	})

	it('separates device codes from other OAuth purposes', () => {
		expect(
			deviceGrantFromCode(
				`aih_dev_${seal('code', { c: 'aihero-cli', s: 'admin:all' })}`,
			),
		).toBeNull()
	})
})
