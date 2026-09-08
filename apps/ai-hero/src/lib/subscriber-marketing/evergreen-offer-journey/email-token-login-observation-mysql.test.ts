import { describe, expect, it } from 'vitest'
import {
	emailObservationInputSchema,
	supportsEmailObservationSerialization,
} from './email-token-login-observation-mysql'

describe('email observation persistence input and serialization gates', () => {
	it('requires exact millisecond revision and private bounded capture', () => {
		const input = {
			userId: 'user',
			email: 'user@example.test',
			verifiedAt: '2026-09-08T00:00:00.123Z',
			acceptedToken: 'stored-token-hash',
			sessionToken: 'actual-session',
			sessionExpires: '2026-09-09T00:00:00.000Z',
		}
		expect(emailObservationInputSchema.parse(input)).toEqual(input)
		for (const override of [
			{ verifiedAt: '2026-09-08T00:00:00Z' },
			{ verifiedAt: 'bad' },
			{ userId: '' },
			{ email: 'not-email' },
			{ sessionToken: '' },
			{ url: 'https://private.test' },
		])
			expect(
				emailObservationInputSchema.safeParse({ ...input, ...override })
					.success,
			).toBe(false)
	})
	it('does not assume Vitess or unknown serialization matches native MySQL', () => {
		expect(
			supportsEmailObservationSerialization('8.0.43', [
				'InnoDB',
				'InnoDB',
				'InnoDB',
				'InnoDB',
				'InnoDB',
			]),
		).toBe(true)
		for (const version of [
			'8.0.30-Vitess',
			'5.7.44',
			'10.6.1-MariaDB',
			'unknown',
		])
			expect(
				supportsEmailObservationSerialization(version, Array(5).fill('InnoDB')),
			).toBe(false)
		expect(
			supportsEmailObservationSerialization('8.0.43', [
				'MyISAM',
				...Array(4).fill('InnoDB'),
			]),
		).toBe(false)
		expect(supportsEmailObservationSerialization('8.0.43', [])).toBe(false)
	})
})
