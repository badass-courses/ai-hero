import { describe, expect, it } from 'vitest'
import { withBotId } from 'botid/next/config'
import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match'

import config from '../../next.config.mjs'
import {
	beforeFilesMarkdownRewrites,
	markdownLikeAcceptHeaderPattern,
} from '../../markdown-route-config.mjs'

describe('composed BotID rewrites', () => {
	it('retains every existing rewrite in the real composed config', async () => {
		if (!config.rewrites) throw new Error('Missing composed rewrites')
		const rewrites = await config.rewrites()
		expect(Array.isArray(rewrites)).toBe(false)
		if (Array.isArray(rewrites)) throw new Error('Expected rewrite phases')
		const beforeFiles = rewrites.beforeFiles ?? []
		expect(beforeFiles).toEqual(
			expect.arrayContaining(beforeFilesMarkdownRewrites),
		)
		const botRewrites = beforeFiles.filter((rule: { destination: string }) =>
			rule.destination.startsWith('https://api.vercel.com/bot-protection/'),
		)
		expect(botRewrites).toHaveLength(2)
		// Existing catch-all content rewrites require markdown negotiation. A
		// normal script request does not satisfy that condition.
		expect(new RegExp(markdownLikeAcceptHeaderPattern).test('*/*')).toBe(false)
		for (const botRule of botRewrites) {
			const scriptPath = botRule.source.replace(':path*', 'p.js')
			for (const rule of beforeFilesMarkdownRewrites as Array<{
				source: string
				has?: Array<{ type: string; key?: string; value?: string }>
			}>) {
				const matchesPath = Boolean(getPathMatch(rule.source)(scriptPath))
				const matchesHeaders = (rule.has ?? []).every(
					(condition) =>
						condition.type === 'header' &&
						condition.key === 'accept' &&
						Boolean(condition.value && new RegExp(condition.value).test('*/*')),
				)
				expect(
					matchesPath && matchesHeaders,
					`${rule.source} must not shadow ${scriptPath}`,
				).toBe(false)
			}
		}
	})

	it('preserves all phases when composing a function or array configuration', async () => {
		const rule = { source: '/synthetic', destination: '/synthetic-destination' }
		const objectConfig = withBotId({
			rewrites: async () => ({
				beforeFiles: [rule],
				afterFiles: [rule],
				fallback: [rule],
			}),
		})
		const objectResult = await objectConfig.rewrites!()
		expect(objectResult).toEqual(
			expect.objectContaining({
				beforeFiles: expect.arrayContaining([rule]),
				afterFiles: [rule],
				fallback: [rule],
			}),
		)
		const arrayConfig = withBotId({ rewrites: async () => [rule] })
		expect(await arrayConfig.rewrites!()).toEqual(
			expect.arrayContaining([rule]),
		)
	})
})
