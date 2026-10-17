import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

describe('pinned BotID browser transports', () => {
	it('patches XHR and fetch, and awaits a challenge before an attested XHR send', () => {
		const source = readFileSync(require.resolve('botid/client/core'), 'utf8')
		expect(source).toMatch(/XMLHttpRequest\.prototype\.open\s*=/)
		expect(source).toMatch(/XMLHttpRequest\.prototype\.send\s*=\s*async/)
		expect(source).toMatch(/window\.fetch\s*=\s*async/)
		const send = source.slice(
			source.indexOf('XMLHttpRequest.prototype.send='),
			source.indexOf('XMLHttpRequest.prototype.send=') + 1200,
		)
		expect(send).toMatch(/await\s+[\w$]+\.getChallenge\(\)/)
		expect(send).toContain('setRequestHeader("x-is-human"')
	})
})
