import { MetadataRoute } from 'next'
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

export default function robots(): MetadataRoute.Robots {
	const crawlRules: {
		allow: string
		disallow: string[]
	} = {
		allow: '/',
		disallow: [...EXCLUDED_ROBOTS_PATHS],
	}

	return {
		rules: [
			{
				userAgent: '*',
				...crawlRules,
			},
			...AI_DISCOVERY_USER_AGENTS.map((userAgent) => ({
				userAgent,
				...crawlRules,
			})),
		],
		sitemap: [
			env.NEXT_PUBLIC_URL + '/sitemap.xml',
			env.NEXT_PUBLIC_URL + '/sitemap.md',
		],
	}
}
