import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import {
	consumeMagicLinkFragment,
	MAGIC_LINK_FRAGMENT_BOOTSTRAP,
	MAGIC_LINK_FRAGMENT_STORAGE_KEY,
	readMagicLinkFragment,
	toFragmentLoginUrl,
} from './magic-link-fragment'

const authJsUrl =
	'https://www.aihero.dev/api/auth/callback/postmark?callbackUrl=https%3A%2F%2Fwww.aihero.dev%2Fwelcome&token=one-time-token&email=learner%40example.com'

describe('magic-link fragment bootstrap', () => {
	function browser(pathname = '/login/verify', hash = '#token=t&email=e%40example.com') {
		const values = new Map<string, string>()
		const location = { pathname, hash, search: '?from=email' }
		return {
			location,
			sessionStorage: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => { values.set(key, value) },
				removeItem: (key: string) => { values.delete(key) },
			},
			history: {
				state: { n: 1 },
				replaceState: vi.fn(() => { location.hash = '' }),
			},
		}
	}

	it('executes a synchronous head scrub before the analytics components mount', () => {
		const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8')
		const head = layout.slice(layout.indexOf('<head>'), layout.indexOf('</head>'))
		expect(head).toMatch(/<script\s+id="magic-link-fragment-bootstrap"/)
		expect(head).toContain('dangerouslySetInnerHTML={{ __html: MAGIC_LINK_FRAGMENT_BOOTSTRAP }}')
		expect(head.indexOf('magic-link-fragment-bootstrap')).toBeLessThan(head.indexOf('<Script'))
		expect(layout.indexOf('</head>')).toBeLessThan(layout.indexOf('<GoogleAnalytics'))
		expect(layout.indexOf('</head>')).toBeLessThan(layout.indexOf('id="google-ads-remarketing"'))

		const win = browser()
		// Run the exact bytes emitted by the head script, then mount analytics.
		runInNewContext(MAGIC_LINK_FRAGMENT_BOOTSTRAP, { window: win })
		const mountAnalytics = vi.fn(() => win.location.hash)
		expect(mountAnalytics()).toBe('')
		expect(win.history.replaceState).toHaveBeenCalledWith({ n: 1 }, '', '/login/verify?from=email')
		expect(consumeMagicLinkFragment(win)).toEqual({ token: 't', email: 'e@example.com', callbackUrl: null })
		expect(win.sessionStorage.getItem(MAGIC_LINK_FRAGMENT_STORAGE_KEY)).toBeNull()
		expect(consumeMagicLinkFragment(win)).toBeNull()
	})

	it('strips the URL even when storage is blocked', () => {
		const win = browser()
		win.sessionStorage.setItem = () => { throw new Error('storage blocked') }
		runInNewContext(MAGIC_LINK_FRAGMENT_BOOTSTRAP, { window: win })
		expect(win.location.hash).toBe('')
		expect(consumeMagicLinkFragment(win)).toBeNull()
	})

	it('does not retain stale credentials on a fresh visit or touch other routes', () => {
		const win = browser('/login/verify', '')
		win.sessionStorage.setItem(MAGIC_LINK_FRAGMENT_STORAGE_KEY, '#token=old&email=old')
		runInNewContext(MAGIC_LINK_FRAGMENT_BOOTSTRAP, { window: win })
		expect(consumeMagicLinkFragment(win)).toBeNull()
		const other = browser('/workshops', '#chapter-one')
		runInNewContext(MAGIC_LINK_FRAGMENT_BOOTSTRAP, { window: other })
		expect(other.location.hash).toBe('#chapter-one')
		expect(other.history.replaceState).not.toHaveBeenCalled()
	})
})

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
