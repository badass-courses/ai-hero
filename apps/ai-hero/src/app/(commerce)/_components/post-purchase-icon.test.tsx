import * as React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PostPurchaseIcon } from './post-purchase-icon'

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
			expect(html).toContain('text-primary')
			expect(html).not.toContain('<animate')
		},
	)

	it('plays the checkmark once, never loops', () => {
		const animation = css.match(/animation:\s*purchase-checkmark([^;]+);/)?.[1]
		expect(animation).toBeDefined()
		expect(animation).toMatch(/300ms/)
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
