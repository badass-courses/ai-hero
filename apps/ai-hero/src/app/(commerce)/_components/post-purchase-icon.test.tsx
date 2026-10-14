import * as React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PostPurchaseIcon, PostPurchaseIconBadge } from './post-purchase-icon'

const css = readFileSync(
	new URL('./post-purchase-icon.module.css', import.meta.url),
	'utf8',
)

describe('post-purchase icons', () => {
	it.each(['ready', 'email'] as const)(
		'keeps the %s artwork decorative',
		(kind) => {
			const html = renderToStaticMarkup(<PostPurchaseIcon kind={kind} />)
			expect(html).toContain('aria-hidden="true"')
			expect(html).toContain('focusable="false"')
			expect(html).toContain(`data-purchase-icon="${kind}"`)
			expect(html).toContain('data-play="once"')
			expect(html).not.toContain('<animate')
		},
	)

	it.each(['ready', 'email'] as const)(
		'uses the same 40px accent badge for %s',
		(kind) => {
			const html = renderToStaticMarkup(<PostPurchaseIconBadge kind={kind} />)
			expect(html).toContain(`data-purchase-badge="${kind}"`)
			expect(html).toContain('h-10 w-10')
			expect(html).toContain('bg-accent-fill text-accent-fill-foreground')
			expect(html).toContain(kind === 'ready' ? 'h-5 w-5' : 'h-4 w-4')
			expect(html).not.toContain('text-primary')
		},
	)

	it('keeps the tick centred with equal stroke bounds and no scale distortion', () => {
		const html = renderToStaticMarkup(<PostPurchaseIconBadge kind="ready" />)
		expect(html).toContain('d="M20 6 9 17l-5-5"')
		expect(html).toContain('stroke-width="2"')
		expect(html).toContain('stroke-linecap="round"')
		expect(html).not.toContain('transform=')
	})

	it('has a 20px eyebrow tick drawn like the stepper\'s', () => {
		const html = renderToStaticMarkup(
			<PostPurchaseIconBadge kind="ready" size="sm" />,
		)
		expect(html).toContain('h-5 w-5')
		expect(html).toContain('h-3.5 w-3.5')
		expect(html).toContain('stroke-width="2.75"')
		expect(html).toContain('d="M20 6 9 17l-5-5"')
		expect(html).toContain('bg-accent-fill text-accent-fill-foreground')
	})

	it('plays the checkmark once, never loops', () => {
		const animation = css.match(/animation:\s*purchase-checkmark([^;]+);/)?.[1]
		expect(animation).toBeDefined()
		expect(animation).toMatch(/450ms/)
		expect(css).toMatch(/\.checkmark \{[^}]*animation-delay: 150ms;/)
		expect(animation).toMatch(/\)\s+1\s+both\s*$/)
		expect(css).not.toMatch(/\binfinite\b/)
		expect(css).not.toMatch(/animation-iteration-count/)
	})

	it('shows the final static frame unless motion is explicitly allowed', () => {
		const guardedMotion = css.match(
			/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n\}/,
		)?.[1]
		expect(guardedMotion).toContain('purchase-checkmark')
		expect(guardedMotion).toContain('purchase-mail')
		expect(css.replace(guardedMotion!, '')).not.toMatch(/animation\s*:/)
		expect(css).toMatch(/\.checkmark\s*\{[^}]*stroke-dashoffset: 0;/)
		expect(css).toMatch(/\.mail\s*\{[^}]*transform: translateY\(0\);/)
	})

	it('does not repeat the payoff after a polled ready handoff', () => {
		const html = renderToStaticMarkup(
			<PostPurchaseIcon kind="ready" play={false} />,
		)
		expect(html).toContain('data-play="static"')
		expect(html).not.toContain('data-play="once"')
		expect(css).toContain("[data-play='once'] .checkmark")
	})
})
