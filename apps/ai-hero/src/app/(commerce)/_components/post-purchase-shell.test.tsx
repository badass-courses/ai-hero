import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PostPurchaseShell } from './post-purchase-shell'

vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('post-purchase shell', () => {
	it('stops all waiting animation on timeout and has an actionable support path', () => {
		const html = renderToStaticMarkup(<PostPurchaseShell step="failed" />)
		expect(html).not.toContain('animate-pulse')
		expect(html).not.toContain('animate-spin')
		expect(html).toContain('animate-none')
		expect(html).toContain('Check again')
		expect(html).toContain('mailto:support@aihero.dev')
		expect(html).toContain('tabindex="-1"')
	})
	it('uses the same shell, live region and reduced-motion skeleton while processing', () => {
		const html = renderToStaticMarkup(<PostPurchaseShell />)
		expect(html).toContain('aria-live="polite"')
		expect(html).toContain('motion-reduce:animate-none')
		expect(html).toContain('Confirming payment')
		expect(html).not.toContain('Payment confirmed')
	})
	it('fills the welcome-shaped placeholders when product details arrive', () => {
		const html = renderToStaticMarkup(
			<PostPurchaseShell
				step="ready"
				title="Synthetic course"
				image="https://example.test/course.png"
			/>,
		)
		expect(html).toContain('Synthetic course')
		expect(html).toContain('Payment confirmed')
		expect(html).toContain('Access set up')
		expect(html).toContain('motion-safe:fade-in')
	})
})
