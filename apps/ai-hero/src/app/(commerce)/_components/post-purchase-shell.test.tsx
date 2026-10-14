import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PostPurchaseShell } from './post-purchase-shell'
import { PostPurchaseLoginLink } from './post-purchase-login-link'

vi.mock('@/components/layout-client', () => ({
	default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('post-purchase shell', () => {
	it.each(['processing', 'slow', 'failed'] as const)('has no animated icon while %s', (step) => {
		const html = renderToStaticMarkup(<PostPurchaseShell step={step} />)
		expect(html).not.toContain('data-purchase-icon')
	})

	it('reveals a checkmark only when access is ready', () => {
		const html = renderToStaticMarkup(<PostPurchaseShell step="ready" />)
		expect(html).toContain('data-purchase-icon="ready"')
		expect(html).not.toContain('data-purchase-icon="email"')
		expect(html).toContain('data-play="once"')
	})

	it('keeps the polled payoff static on arrival, without repeating it', () => {
		const html = renderToStaticMarkup(<PostPurchaseShell step="ready" readyWasShown />)
		expect(html).toContain('data-play="static"')
		expect(html).not.toContain('data-play="once"')
	})

	it('shows mail beside the login-link address, not another checkmark', () => {
		const html = renderToStaticMarkup(
			<PostPurchaseShell step="email">
				<PostPurchaseLoginLink email="buyer@example.test" />
			</PostPurchaseShell>,
		)
		expect(html).toContain('data-purchase-icon="email"')
		expect(html).not.toContain('data-purchase-icon="ready"')
		expect(html).toContain('Open the login link we emailed you')
		expect(html).toContain('buyer@example.test')
		expect(html).toContain('aria-live="polite"')
	})

	it('says each status once on screen, with the live region for screen readers', () => {
		const html = renderToStaticMarkup(
			<PostPurchaseShell step="email">
				<PostPurchaseLoginLink email="buyer@example.test" />
			</PostPurchaseShell>,
		)
		expect(html.match(/One last step/g)).toHaveLength(1)
		expect(html).toMatch(/role="status"[^>]*class="sr-only"/)
		const waiting = renderToStaticMarkup(<PostPurchaseShell step="processing" />)
		expect(waiting.match(/This usually takes a few seconds/g)).toHaveLength(2)
		expect(waiting).toMatch(/aria-hidden="true"[^>]*><p[^>]*>Setting up your access/)
	})

	it('stops all waiting animation on timeout and has an actionable support path', () => {
		const html = renderToStaticMarkup(<PostPurchaseShell step="failed" />)
		expect(html).not.toContain('animate-pulse')
		expect(html).not.toContain('animate-spin')
		expect(html).toContain('Do not pay again')
		expect(html).toContain('Check again')
		expect(html).toContain('mailto:support@aihero.dev')
		expect(html).toContain('tabindex="-1"')
		expect(html).toContain('outline-none')
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
