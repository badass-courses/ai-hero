import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { requestOAuthAccountLink } from './oauth-link-actions'

const actionSource = readFileSync(
	new URL('./oauth-link-actions.ts', import.meta.url),
	'utf8',
)

describe('OAuth account link action containment', () => {
	it('is disabled for anonymous and authenticated callers', async () => {
		await expect(requestOAuthAccountLink()).resolves.toEqual({
			status: 'disabled',
		})
	})

	it('ignores forged runtime arguments', async () => {
		const result = await Reflect.apply(requestOAuthAccountLink, null, [
			'github',
			'victim-user-id',
		])

		expect(result).toEqual({ status: 'disabled' })
	})

	it('has no caller-selected identity or side-effect capability', () => {
		expect(requestOAuthAccountLink).toHaveLength(0)
		expect(actionSource).not.toContain('userId')
		expect(actionSource).not.toContain("from 'next/headers'")
		expect(actionSource).not.toContain('cookies(')
		expect(actionSource).not.toContain('linkAccount')
		expect(actionSource).not.toContain('inngest')
	})
})
