export const markdownLikeAcceptHeaderPattern =
	'(?=.*(?:text/plain|text/markdown))(?!.*text/html.*(?:text/plain|text/markdown)).*'

const markdownAcceptHeader = [
	{
		type: 'header',
		key: 'accept',
		value: markdownLikeAcceptHeaderPattern,
	},
]

export const discoveryRouteBypassRewrites = [
	{
		source: '/.well-known/:path*',
		destination: '/.well-known/:path*',
	},
	{
		source: '/api/:path*',
		destination: '/api/:path*',
	},
	{
		source: '/llms.txt',
		destination: '/llms.txt',
	},
	{
		source: '/robots.txt',
		destination: '/robots.txt',
	},
	{
		source: '/rss.xml',
		destination: '/rss.xml',
	},
	{
		source: '/sitemap.xml',
		destination: '/sitemap.xml',
	},
	{
		source: '/sitemap.md',
		destination: '/sitemap.md',
	},
]

export const explicitMarkdownRewrites = [
	{
		source: '/products/:slug.md',
		destination: '/md/products/:slug',
	},
	{
		source: '/cohorts/:slug.md',
		destination: '/md/cohorts/:slug',
	},
	{
		source: '/events/:slug.md',
		destination: '/md/events/:slug',
	},
	{
		source: '/workshops/:module/:lesson.md',
		destination: '/md/workshops/:module/:lesson',
	},
	{
		source: '/workshops/:module.md',
		destination: '/md/workshops/:module',
	},
	{
		source: '/tutorials/:module/:lesson.md',
		destination: '/md/tutorials/:module/:lesson',
	},
	{
		source: '/:slug((?!sitemap).+).md',
		destination: '/md/:slug',
	},
]

export const negotiatedMarkdownRewrites = [
	{
		source: '/',
		destination: '/md/home',
		has: markdownAcceptHeader,
	},
	{
		source: '/workshops/:module/:lesson',
		destination: '/md/workshops/:module/:lesson',
		has: markdownAcceptHeader,
	},
	{
		source: '/tutorials/:module/:lesson',
		destination: '/md/tutorials/:module/:lesson',
		has: markdownAcceptHeader,
	},
	{
		// `md/` is excluded so this rewrite cannot re-match its own destination:
		// Vercel's routing layer re-checks routes after a rewrite with the
		// original Accept header, so without it `/` -> `/md/home` -> `/md/md/home`
		// and every negotiated request 404s in production.
		source:
			'/:slug((?!api/|api$|md/|md$|llms\\.txt$|robots\\.txt$|rss\\.xml$|sitemap\\.md$|sitemap\\.xml$).+)',
		destination: '/md/:slug',
		has: markdownAcceptHeader,
	},
]

export const beforeFilesMarkdownRewrites = [
	...discoveryRouteBypassRewrites,
	...explicitMarkdownRewrites,
	...negotiatedMarkdownRewrites,
]

export const homepageDiscoveryLinkHeader = [
	'</api/openapi.json>; rel="service-desc"; type="application/openapi+json"',
	'</llms.txt>; rel="service-doc"; type="text/plain"',
].join(', ')

export const homepageDiscoveryHeaders = [
	{
		source: '/',
		headers: [
			{
				key: 'Link',
				value: homepageDiscoveryLinkHeader,
			},
			{
				key: 'Vary',
				value: 'Accept',
			},
		],
	},
]
