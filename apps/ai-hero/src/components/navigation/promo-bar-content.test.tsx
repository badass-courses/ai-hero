// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { PromoBarContent } from './promo-bar-content'
import { CRASH_COURSE_PROMO, FEATURED_PROMO } from './promo-config'

const { prefetch } = vi.hoisted(() => ({ prefetch: vi.fn() }))

vi.mock('next/navigation', () => ({
	useRouter: () => ({ prefetch }),
}))

vi.mock('next/link', () => ({
	default: ({
		prefetch,
		...props
	}: React.ComponentProps<'a'> & { prefetch?: boolean }) => (
		<a {...props} data-prefetch={prefetch} />
	),
}))

describe('promo link prefetch', () => {
	it.each([
		{ href: '/workshops/example', shouldPrefetch: true },
		{ href: '/s/example', shouldPrefetch: false },
	])('gates prefetch for $href', async ({ href, shouldPrefetch }) => {
		prefetch.mockClear()
		vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
		const container = document.createElement('div')
		document.body.append(container)
		const root = createRoot(container)
		try {
			await act(async () => {
				root.render(<PromoBarContent promo={{ ...FEATURED_PROMO, href }} />)
			})
			const link = container.querySelector('a')
			if (!link) throw new Error('Expected the promo link')
			expect(link.getAttribute('data-prefetch')).toBe('false')
			expect(prefetch).not.toHaveBeenCalled()

			link.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
			expect(prefetch.mock.calls).toEqual(shouldPrefetch ? [[href]] : [])

			prefetch.mockClear()
			link.focus()
			expect(prefetch.mock.calls).toEqual(shouldPrefetch ? [[href]] : [])
		} finally {
			await act(async () => root.unmount())
			container.remove()
			vi.unstubAllGlobals()
		}
	})
})

describe('responsive promo copy', () => {
	it('server-renders short mobile and full desktop copy with CSS-only selection', () => {
		const html = renderToStaticMarkup(
			<PromoBarContent promo={FEATURED_PROMO} />,
		)
		expect(html).toContain(
			'<span class="whitespace-nowrap leading-[1.4] sm:hidden">Software Factories cohort: enrollment open</span>',
		)
		expect(html).toContain(
			'<span class="hidden truncate leading-[1.4] sm:inline">Software Factories for Real Engineers: enrollment is open.</span>',
		)
		expect(html).toContain('hidden sm:inline-flex')
		expect(html).toContain('href="/s/c5-site-banner"')
		expect(html).toContain('h-[34px]')
	})

	it('keeps the Crash Course markup and message unchanged', () => {
		const html = renderToStaticMarkup(
			<PromoBarContent promo={CRASH_COURSE_PROMO} />,
		)
		expect(html).toContain(
			'<span class="truncate leading-[1.4]">AI Coding Crash Course is out now.</span>',
		)
		expect(html).not.toContain('sm:hidden')
		expect(html).not.toContain('hidden sm:inline-flex')
		expect(html).toContain('href="/s/crash-course"')
	})
})
