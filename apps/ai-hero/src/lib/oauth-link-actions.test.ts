import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const actionSource = readFileSync(
	new URL('./oauth-link-actions.ts', import.meta.url),
	'utf8',
)

describe('OAuth account link server action wiring', () => {
	it.each(['requestOAuthAccountLink', 'requestGithubOAuthAccountLink'])(
		'exposes %s without caller-selected identity or provider',
		(actionName) => {
			expect(actionSource).toMatch(
				new RegExp(`export async function ${actionName}\\(\\)\\s*{`),
			)
		},
	)

	it('constructs separate fixed-provider request handlers', () => {
		expect(actionSource).toContain("provider: 'discord'")
		expect(actionSource).toContain("provider: 'github'")
		expect(actionSource).toContain(
			'isUserAllowed: isGithubOAuthLinkEnabledForUser',
		)
		expect(actionSource).not.toContain('unlinkAccount')
	})

	it('clears both intent variants before issuance and writing with the shared runtime policy', () => {
		expect(actionSource).toContain(
			'getCookiePolicy: getRuntimeAuthCookiePolicy',
		)
		expect(actionSource.match(/clearIntentCookies,/g)).toHaveLength(2)
		expect(
			actionSource.match(/clearOAuthLinkIntentCookies\(cookieStore\)/g),
		).toHaveLength(2)
		const clearIndex = actionSource.indexOf(
			'clearOAuthLinkIntentCookies(cookieStore)',
		)
		const writeIndex = actionSource.indexOf(
			'writeOAuthLinkIntentCookie(cookieStore, input, cookiePolicy)',
		)
		expect(clearIndex).toBeGreaterThanOrEqual(0)
		expect(writeIndex).toBeGreaterThan(clearIndex)
	})

	it('keeps Discord on its existing secure flow', () => {
		expect(actionSource).toContain("await signIn('discord'")
		expect(actionSource).toContain("redirectTo: '/discord/redirect'")
	})

	it('starts GitHub with a bounded profile return and no identity fields', () => {
		expect(actionSource).toContain("await signIn('github'")
		expect(actionSource).toContain("redirectTo: '/profile?link=linked'")
		expect(actionSource).toContain("redirect('/profile?link=not-enabled')")
		for (const forbidden of [
			'name="userId"',
			'name="provider"',
			'providerAccountId',
			'access_token',
		]) {
			expect(actionSource).not.toContain(forbidden)
		}
	})
})
