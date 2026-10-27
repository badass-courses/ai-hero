import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) =>
	readFileSync(new URL(path, import.meta.url), 'utf8')

describe('subscribe bot bundle boundaries', () => {
	it('does not add BotID or a connection boundary to the root layout', () => {
		const root = source('../app/layout.tsx')
		expect(root).not.toContain('subscribe-bot')
		expect(root).not.toMatch(/\bconnection\s*\(/)
	})

	it('keeps name thresholds out of every client-side protection module', () => {
		for (const path of [
			'./subscribe-bot-routes.ts',
			'../components/subscribe-bot-client.tsx',
			'../components/subscribe-bot-protection.tsx',
			'../hooks/use-subscribe-bot-protection.ts',
		]) {
			expect(source(path)).not.toMatch(
				/subscribe-bot-(config|decision|defense)/,
			)
		}
	})
})
