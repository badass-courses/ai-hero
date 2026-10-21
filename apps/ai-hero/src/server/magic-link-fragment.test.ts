import { describe, expect, it, vi } from 'vitest'

import {
	consumeMagicLinkFragment,
	readMagicLinkFragment,
	toFragmentLoginUrl,
} from './magic-link-fragment'

const authJsUrl =
	'https://www.aihero.dev/api/auth/callback/postmark?callbackUrl=https%3A%2F%2Fwww.aihero.dev%2Fwelcome&token=one-time-token&email=learner%40example.com'

describe('magic-link fragment link', () => {
	it('moves token, email and callbackUrl out of the query string', () => {
		const link = new URL(toFragmentLoginUrl(authJsUrl))

		expect(link.origin).toBe('https://www.aihero.dev')
		expect(link.pathname).toBe('/login/verify')
		expect(link.search).toBe('')
		expect(readMagicLinkFragment(link.hash)).toEqual({
			token: 'one-time-token',
			email: 'learner@example.com',
			callbackUrl: 'https://www.aihero.dev/welcome',
		})
	})

	it('round-trips awkward characters and omits an absent callbackUrl', () => {
		const url =
			'https://www.aihero.dev/api/auth/callback/postmark?token=a%26b%3Dc%23d&email=a%2Bb%40example.com'
		const link = new URL(toFragmentLoginUrl(url))

		expect(readMagicLinkFragment(link.hash)).toEqual({
			token: 'a&b=c#d',
			email: 'a+b@example.com',
			callbackUrl: null,
		})
	})

	it('leaves other URLs and incomplete callbacks alone', () => {
		for (const url of [
			'https://www.aihero.dev/somewhere?token=x&email=y',
			'https://www.aihero.dev/api/auth/callback/postmark?email=y',
			'not a url',
		]) {
			expect(toFragmentLoginUrl(url)).toBe(url)
		}
	})

	it('requires both token and email in the fragment', () => {
		expect(readMagicLinkFragment('')).toBeNull()
		expect(readMagicLinkFragment('#token=x')).toBeNull()
		expect(readMagicLinkFragment('#email=x')).toBeNull()
	})

	it('clears the fragment from the address bar once read', () => {
		const replaceState = vi.fn()
		const result = consumeMagicLinkFragment({
			location: {
				hash: '#token=t&email=e%40example.com',
				pathname: '/login/verify',
				search: '',
			},
			history: { state: { n: 1 }, replaceState },
		})

		expect(result).toEqual({
			token: 't',
			email: 'e@example.com',
			callbackUrl: null,
		})
		expect(replaceState).toHaveBeenCalledWith({ n: 1 }, '', '/login/verify')
	})

	it('does not touch history when there is no fragment', () => {
		const replaceState = vi.fn()
		const result = consumeMagicLinkFragment({
			location: { hash: '', pathname: '/login/verify', search: '' },
			history: { state: null, replaceState },
		})

		expect(result).toBeNull()
		expect(replaceState).not.toHaveBeenCalled()
	})
})
