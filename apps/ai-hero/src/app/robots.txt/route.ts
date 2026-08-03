import { env } from '@/env.mjs'

export const AI_DISCOVERY_USER_AGENTS = [
	'GPTBot',
	'ChatGPT-User',
	'ClaudeBot',
	'CCBot',
	'PerplexityBot',
] as const

export const EXCLUDED_ROBOTS_PATHS = [
	'/confirm',
	'/confirmed',
	'/excited',
	'/redirect',
	'/unsubscribed',
	'/answer',
	'/login',
	'/thanks',
	'/welcome',
	'/team',
	'/error',
	'/check-your-email',
	'/progress',
] as const

export const CONTENT_SIGNALS = 'search=yes, ai-input=yes, ai-train=yes'

function formatRobotsGroup(userAgent: string) {
	return [
		`User-agent: ${userAgent}`,
		`Content-Signal: ${CONTENT_SIGNALS}`,
		'Allow: /',
		...EXCLUDED_ROBOTS_PATHS.map((path) => `Disallow: ${path}`),
	].join('\n')
}

export function buildRobotsTxt(baseUrl = env.NEXT_PUBLIC_URL) {
	const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
	const groups = ['*', ...AI_DISCOVERY_USER_AGENTS]
		.map(formatRobotsGroup)
		.join('\n\n')

	return `${groups}\n\nSitemap: ${normalizedBaseUrl}/sitemap.xml\nSitemap: ${normalizedBaseUrl}/sitemap.md\n`
}

export async function GET() {
	return new Response(buildRobotsTxt(), {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}
