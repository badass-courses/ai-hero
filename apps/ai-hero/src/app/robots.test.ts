import { GET } from '@/app/robots.txt/route'
import {
	AI_DISCOVERY_USER_AGENTS,
	buildRobotsTxt,
	CONTENT_SIGNALS,
	EXCLUDED_ROBOTS_PATHS,
} from '@/lib/robots-config'
import { describe, expect, it } from 'vitest'

function getGroup(body: string, userAgent: string) {
	return body
		.split(/\n\n/)
		.find((group) => group.startsWith(`User-agent: ${userAgent}\n`))
}

describe('robots policy', () => {
	it('keeps wildcard and named agent groups with permissive content signals', () => {
		const body = buildRobotsTxt('https://www.aihero.dev')

		for (const userAgent of ['*', ...AI_DISCOVERY_USER_AGENTS]) {
			const group = getGroup(body, userAgent)
			expect(group).toBeDefined()
			expect(group).toContain(`Content-Signal: ${CONTENT_SIGNALS}`)
			expect(group).toContain('Allow: /')

			for (const path of EXCLUDED_ROBOTS_PATHS) {
				expect(group).toContain(`Disallow: ${path}`)
			}
		}
	})

	it('continues to advertise both sitemap surfaces', () => {
		const body = buildRobotsTxt('http://localhost:3000/')

		expect(body).toContain('Sitemap: http://localhost:3000/sitemap.xml')
		expect(body).toContain('Sitemap: http://localhost:3000/sitemap.md')
	})

	it('serves robots.txt as plain text', async () => {
		const response = await GET()

		expect(response.status).toBe(200)
		expect(response.headers.get('Content-Type')).toBe(
			'text/plain; charset=utf-8',
		)
		await expect(response.text()).resolves.toContain('User-agent: GPTBot')
	})
})
