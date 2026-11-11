import { describe, expect, it } from 'vitest'

import { checkRevalidateAuth } from './revalidate-auth'

const SECRET = 'a-long-random-revalidate-secret-for-tests-only'

describe('checkRevalidateAuth', () => {
	it('accepts the configured secret as a bearer header', () => {
		expect(
			checkRevalidateAuth({
				configuredSecret: SECRET,
				authorization: `Bearer ${SECRET}`,
				hasQuerySecret: false,
			}),
		).toEqual({ ok: true })
	})

	it('refuses a wrong secret', () => {
		expect(
			checkRevalidateAuth({
				configuredSecret: SECRET,
				authorization: 'Bearer nope',
				hasQuerySecret: false,
			}),
		).toMatchObject({ ok: false, status: 401 })
	})

	it('refuses a missing or malformed header', () => {
		for (const authorization of [null, '', SECRET, `Basic ${SECRET}`]) {
			expect(
				checkRevalidateAuth({
					configuredSecret: SECRET,
					authorization,
					hasQuerySecret: false,
				}),
			).toMatchObject({ ok: false, status: 401 })
		}
	})

	it('refuses any query-string secret, even a correct one', () => {
		expect(
			checkRevalidateAuth({
				configuredSecret: SECRET,
				authorization: `Bearer ${SECRET}`,
				hasQuerySecret: true,
			}),
		).toMatchObject({ ok: false, status: 400 })
	})

	it('fails closed when no secret is configured', () => {
		for (const configuredSecret of [undefined, '']) {
			expect(
				checkRevalidateAuth({
					configuredSecret,
					authorization: 'Bearer ',
					hasQuerySecret: false,
				}),
			).toMatchObject({ ok: false, status: 503 })
		}
	})
})
