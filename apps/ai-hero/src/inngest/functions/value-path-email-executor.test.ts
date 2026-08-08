import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('valuePathEmailExecutor production config', () => {
	it('paces Kit writes ten seconds apart', async () => {
		const source = await readFile(
			new URL('./value-path-email-executor.ts', import.meta.url),
			'utf8',
		)

		expect(source).toContain('providerPacingMs: 10_000')
	})
})
