import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
	new URL('./ads-operator.ts', import.meta.url),
	'utf8',
)

describe('ads operator process lifecycle', () => {
	it('closes the app database pool after success or failure', () => {
		expect(source).toContain("import { closeDatabasePool, db } from '@/db'")
		expect(source).toMatch(/finally \{\s*await closeDatabasePool\(\)\s*\}/)
		expect(source.indexOf('console.log(')).toBeLessThan(
			source.lastIndexOf('await closeDatabasePool()'),
		)
		expect(source).not.toContain('process.exit(1)')
		expect(source).toContain('process.exitCode = 1')
	})
})
