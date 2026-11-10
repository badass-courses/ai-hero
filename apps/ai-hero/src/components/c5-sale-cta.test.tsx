import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { C5SaleCta } from './c5-sale-cta'

vi.mock('@/components/cld-image', () => ({ CldImage: () => null }))

// Both team hubs use this shared card, including the skills MDX replacements.
describe('C5 sale CTA destinations', () => {
	it.each([false, true])('links to the tracked cohort page with forTeams=%s', (forTeams) => {
		const html = renderToStaticMarkup(<C5SaleCta forTeams={forTeams} />)
		expect(html).toContain('href="/s/c5-site-cta"')
		expect(html).toContain('Software Factories for Real Engineers')
		expect(html).toContain(forTeams ? 'Join with your team' : 'Join the cohort')
		expect(html).not.toContain('/for-teams')
	})
})
