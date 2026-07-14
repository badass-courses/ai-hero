/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import createMDX from '@next/mdx'
import { withAxiom } from 'next-axiom'

import { beforeFilesMarkdownRewrites } from './markdown-route-config.mjs'
import { env } from './src/env.mjs'

await import('./src/env.mjs')

const withMDX = createMDX({
	options: {},
})

/** @type {import("next").NextConfig} */
const config = {
	experimental: {
		mdxRs: true,
		turbopackFileSystemCacheForDev: true,
		serverComponentsHmrCache: true,
		optimizePackageImports: ['lucide-react', '@coursebuilder/ui', 'shiki'],
	},
	serverExternalPackages: ['liquidjs'],
	allowedDevOrigins: ['localhost:3000', '*.ngrok.app', '*.coursebuilder.dev'],
	images: {
		remotePatterns: [
			{
				protocol: 'https',
				hostname: 'res.cloudinary.com',
				port: '',
			},
			{
				protocol: 'https',
				hostname: 'image.mux.com',
				port: '',
			},
			{
				protocol: 'https',
				hostname: 'avatars.githubusercontent.com',
				port: '',
			},
			{
				protocol: 'https',
				hostname: 'cdn.discordapp.com',
				port: '',
			},
			{
				protocol: 'https',
				hostname: env.NEXT_PUBLIC_URL.replace('https://', ''),
				port: '',
			},
		],
	},
	pageExtensions: ['mdx', 'ts', 'tsx'],
	transpilePackages: [
		'@coursebuilder/ui',
		'@coursebuilder/commerce-next',
		'@coursebuilder/survey',
		'next-mdx-remote',
		'shiki',
	],
	async redirects() {
		return [
			{
				source: '/ai-coding-for-real-engineers-with-claude-code-2026-04',
				destination: '/claude-code-for-real-engineers-2026-04',
				permanent: true,
			},
			{
				source:
					'/(cohorts/)?build-your-own-ai-personal-assistant-in-type-script(.*)',
				destination:
					'/cohorts/build-your-own-ai-personal-assistant-in-typescript',
				permanent: true,
			},
			{
				source: '/workshops/ai-sdk-v5-crash-course',
				destination: '/workshops/ai-sdk-v6-crash-course',
				permanent: true,
			},
			{
				source: '/11-tips-for-ai-coding-with-ralph-wiggum',
				destination: '/tips-for-ai-coding-with-ralph-wiggum',
				permanent: true,
			},
			{
				source: '/ai-skills-for-real-engineers',
				destination: '/workshops/ai-skills-for-real-engineers',
				permanent: false,
			},
			{
				source: '/skills-v1-0-release',
				destination: '/skills/skills-changelog-v1-announcement',
				permanent: true,
			},
			{
				source: '/articles/triage',
				destination: '/burn-through-your-backlog-with-my-triage-skill',
				permanent: true,
			},
			{
				source: '/skills-domain-model',
				destination: '/grill-with-docs',
				permanent: true,
			},
			// Skills 1.1 renames (to-prd → to-spec, review → code-review,
			// to-issues → to-tickets). Slugs changed in the CMS; forward the old
			// URLs so existing links/bookmarks don't 404.
			{
				source: '/skills-to-prd',
				destination: '/skills-to-spec',
				permanent: true,
			},
			{
				source: '/skills-review',
				destination: '/skills-code-review',
				permanent: true,
			},
			{
				source: '/skills-to-issues',
				destination: '/skills-to-tickets',
				permanent: true,
			},
		]
	},
	async rewrites() {
		return {
			beforeFiles: beforeFilesMarkdownRewrites,
		}
	},
}

export default withAxiom(withMDX(config))
