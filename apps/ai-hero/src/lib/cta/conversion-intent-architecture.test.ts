import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migratedSurfaces = [
	'src/app/(content)/skills/_components/skills-course-form.tsx',
	'src/app/(content)/skills/_components/skills-newsletter.tsx',
	'src/components/landing/slim-newsletter-form.tsx',
	'src/components/cohort-waitlist-form.tsx',
	'src/app/(content)/cohorts/[slug]/_components/cohort-pricing-widget-container.tsx',
	'src/app/(content)/workshops/_components/workshop-interest-cta.tsx',
]

describe('conversion intent architecture', () => {
	it('prevents migrated surfaces from bypassing the intent-aware form', () => {
		for (const path of migratedSurfaces) {
			const source = readFileSync(resolve(process.cwd(), path), 'utf8')
			expect(source, path).not.toContain('<SubscribeToConvertkitForm')
			expect(source, path).not.toMatch(
				/import[^\n]*SubscribeToConvertkitForm[^\n]*from ['"]@\/convertkit['"]/,
			)
			expect(source, path).toContain('ConversionIntentForm')
		}
	})
})
