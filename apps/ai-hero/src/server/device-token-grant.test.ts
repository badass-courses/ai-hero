import { describe, expect, it, vi } from 'vitest'
vi.mock('@/db', () => ({ db: {} }))
import { seal } from '@/lib/learner-agent/oauth/sealed'
import {
	deviceGrantFromCode,
	mintDeviceCode,
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
	it('separates device codes from other OAuth purposes', () => {
		expect(
			deviceGrantFromCode(
				`aih_dev_${seal('code', { c: 'aihero-cli', s: 'admin:all' })}`,
			),
		).toBeNull()
	})
})
