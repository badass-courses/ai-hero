import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PromoBarContent } from './promo-bar-content'
import { CRASH_COURSE_PROMO, FEATURED_PROMO } from './promo-config'

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
