import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const actionSource = readFileSync(
	new URL('./oauth-link-actions.ts', import.meta.url),
	'utf8',
)

describe('OAuth account link server action wiring', () => {
	it('accepts no caller-selected identity or provider', () => {
		expect(actionSource).toMatch(
			/export async function requestOAuthAccountLink\(\)\s*{/,
		)
		expect(actionSource).not.toContain(
			'function requestOAuthAccountLink(' + 'userId',
		)
		expect(actionSource).not.toContain(
			'function requestOAuthAccountLink(' + 'provider',
		)
		expect(actionSource).not.toContain('unlinkAccount')
	})

	it('uses the session-derived request handler and fixed Discord sign-in', () => {
		expect(actionSource).toContain('createOAuthAccountLinkRequest')
		expect(actionSource).toContain("await signIn('discord'")
		expect(actionSource).toContain("redirectTo: '/discord/redirect'")
	})
})
