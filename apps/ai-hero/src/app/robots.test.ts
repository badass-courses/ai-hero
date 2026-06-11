import robots, {
	AI_DISCOVERY_USER_AGENTS,
	EXCLUDED_ROBOTS_PATHS,
} from '@/app/robots'
import { describe, expect, it } from 'vitest'

describe('robots policy', () => {
	it('keeps wildcard rules while adding explicit named agent entries', () => {
		const result = robots()
		const rules = Array.isArray(result.rules) ? result.rules : [result.rules]
		const wildcardRule = rules.find((rule) => rule.userAgent === '*')

		expect(wildcardRule).toEqual(
			expect.objectContaining({
				userAgent: '*',
				allow: '/',
				disallow: [...EXCLUDED_ROBOTS_PATHS],
			}),
		)

		for (const userAgent of AI_DISCOVERY_USER_AGENTS) {
			expect(rules).toContainEqual(
				expect.objectContaining({
					userAgent,
					allow: '/',
					disallow: [...EXCLUDED_ROBOTS_PATHS],
				}),
			)
		}
	})

	it('continues to advertise both sitemap surfaces', () => {
		const result = robots()

		expect(result.sitemap).toEqual([
			'http://localhost:3000/sitemap.xml',
			'http://localhost:3000/sitemap.md',
		])
	})
})
