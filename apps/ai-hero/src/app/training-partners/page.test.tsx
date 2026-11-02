import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/layout-client', () => ({
	default: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))
vi.mock('@/components/team-inquiry/team-inquiry-actions', () => ({
	sendTeamInquiry: vi.fn(),
}))

import { TeamInquiryForm } from '@/components/team-inquiry/team-inquiry-form'

import TrainingPartnersPage from './page'

describe('training partners lead form', () => {
	it('renders required routing fields and makes the form the main CTA', () => {
		const html = renderToStaticMarkup(<TrainingPartnersPage />)
		expect(html).toContain('Country')
		expect(html).toMatch(/<input[^>]*id="country"[^>]*required=""/)
		expect(html).toContain('What do you need?')
		expect(html.match(/type="radio"[^>]*required=""/g)).toHaveLength(2)
		expect(html).toContain('Live training for my team')
		expect(html).toContain('Self-paced seats for my team')
		expect(html.indexOf('<form')).toBeLessThan(html.indexOf('inovex logo'))
		for (const partner of ['inovex logo', 'This Dot Labs logo']) {
			expect(html).toContain(partner)
		}
		// The form is the only path to a partner: no outbound links or contact
		// details on the page.
		for (const outbound of [
			'inovex.de',
			'thisdot.co',
			'Prefer to contact a partner directly?',
			'target="_blank"',
			'mailto:',
			'tel:',
		]) {
			expect(html).not.toContain(outbound)
		}
		const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? '')
		expect(hrefs.every((href) => href.startsWith('/'))).toBe(true)
		expect(hrefs).toContain('/for-your-team')
		for (const forbidden of ['Cohort', 'C5', 'Software Factories', '—']) {
			expect(html).not.toContain(forbidden)
		}
	})

	it('uses Send inquiry for the training partners submit button', () => {
		const html = renderToStaticMarkup(
			<TeamInquiryForm
				location="/training-partners"
				source="training-partners"
			/>,
		)
		const button = html.match(
			/<button[^>]*type="submit"[^>]*>(.*?)<\/button>/s,
		)?.[1]
		expect(button).toContain('Send inquiry')
		expect(button).not.toContain('Get team pricing')
	})

	it('does not render partner fields in the existing for-your-team form', () => {
		const html = renderToStaticMarkup(
			<TeamInquiryForm location="/for-your-team" />,
		)
		const button = html.match(
			/<button[^>]*type="submit"[^>]*>(.*?)<\/button>/s,
		)?.[1]
		expect(button).toContain('Get team pricing')
		expect(button).not.toContain('Send inquiry')
		for (const field of ['country', 'trainingType', 'What do you need?']) {
			expect(html).not.toContain(field)
		}
	})
})
