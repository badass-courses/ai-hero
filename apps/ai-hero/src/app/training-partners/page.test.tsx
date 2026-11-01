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
		expect(
			html.indexOf('Prefer to contact a partner directly?'),
		).toBeGreaterThan(html.indexOf('</form>'))
		for (const partner of [
			'inovex logo',
			'This Dot Labs logo',
			'https://www.inovex.de/',
			'https://www.thisdot.co/',
		]) {
			expect(html).toContain(partner)
		}
		for (const forbidden of ['Cohort', 'C5', 'Software Factories', '—']) {
			expect(html).not.toContain(forbidden)
		}
	})

	it('does not render partner fields in the existing for-your-team form', () => {
		const html = renderToStaticMarkup(
			<TeamInquiryForm location="/for-your-team" />,
		)
		expect(html).toContain('Get team pricing')
		for (const field of ['country', 'trainingType', 'What do you need?']) {
			expect(html).not.toContain(field)
		}
	})
})
