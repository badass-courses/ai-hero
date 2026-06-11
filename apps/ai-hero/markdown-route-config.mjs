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
		source:
			'/:slug((?!api/|api$|llms\\.txt$|robots\\.txt$|rss\\.xml$|sitemap\\.md$|sitemap\\.xml$).+)',
		destination: '/md/:slug',
		has: markdownAcceptHeader,
	},
]

export const beforeFilesMarkdownRewrites = [
	...discoveryRouteBypassRewrites,
	...explicitMarkdownRewrites,
	...negotiatedMarkdownRewrites,
]
