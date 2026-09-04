import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import {
	DEFAULT_VALUE_PATH_PROVIDER_PACING_MS,
	parseValuePathProviderPacingMs,
} from './value-path-provider-pacing'

describe('valuePathEmailExecutor production config', () => {
	it('defaults provider pacing to ten seconds', () => {
		expect(parseValuePathProviderPacingMs(undefined)).toBe(
			DEFAULT_VALUE_PATH_PROVIDER_PACING_MS,
		)
	})

	it('accepts explicit zero and a valid override', () => {
		expect(parseValuePathProviderPacingMs('0')).toBe(0)
		expect(parseValuePathProviderPacingMs('2500')).toBe(2500)
	})

	it.each(['', '-1', '1.5', 'ten-seconds', '01', '9007199254740992'])(
		'rejects invalid pacing value %j',
		(value) => {
			expect(() => parseValuePathProviderPacingMs(value)).toThrow(
				'AIH_VALUE_PATH_PROVIDER_PACING_MS',
			)
		},
	)

	it('passes the strict environment parser and isolated shadow observer into the production cron', async () => {
		const source = await readFile(
			new URL('./value-path-email-executor.ts', import.meta.url),
			'utf8',
		)
		expect(source).toContain(
			'parseValuePathProviderPacingMs(\n\t\t\t\tprocess.env.AIH_VALUE_PATH_PROVIDER_PACING_MS',
		)
		expect(source).toContain('shadowObserver: createEmailCourseShadowRuntime({')
		expect(source).toContain('}).observeDelivery')
	})
})
