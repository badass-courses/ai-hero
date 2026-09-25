import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { evergreenSenderPacingMs } from './evergreen-sender-pacing'
import { DEFAULT_VALUE_PATH_PROVIDER_PACING_MS } from './value-path-provider-pacing'

describe('evergreen sender pacing', () => {
	it('is exactly today’s shared pacing when its own knob is unset', () => {
		expect(evergreenSenderPacingMs({})).toBe(
			DEFAULT_VALUE_PATH_PROVIDER_PACING_MS,
		)
		expect(evergreenSenderPacingMs({})).toBe(10_000)
		expect(
			evergreenSenderPacingMs({ AIH_VALUE_PATH_PROVIDER_PACING_MS: '7000' }),
		).toBe(7_000)
		expect(
			evergreenSenderPacingMs({
				AIH_DROVR_EVERGREEN_SENDER_PACING_MS: '  ',
				AIH_VALUE_PATH_PROVIDER_PACING_MS: '7000',
			}),
		).toBe(7_000)
	})

	it('uses its own knob when set, leaving the value-path pacing alone', () => {
		expect(
			evergreenSenderPacingMs({
				AIH_DROVR_EVERGREEN_SENDER_PACING_MS: '3000',
				AIH_VALUE_PATH_PROVIDER_PACING_MS: '10000',
			}),
		).toBe(3_000)
		expect(
			evergreenSenderPacingMs({ AIH_DROVR_EVERGREEN_SENDER_PACING_MS: '0' }),
		).toBe(0)
	})

	it('refuses a malformed value by its own name', () => {
		expect(() =>
			evergreenSenderPacingMs({ AIH_DROVR_EVERGREEN_SENDER_PACING_MS: '3s' }),
		).toThrow(
			'AIH_DROVR_EVERGREEN_SENDER_PACING_MS must be a non-negative integer',
		)
		expect(() =>
			evergreenSenderPacingMs({ AIH_DROVR_EVERGREEN_SENDER_PACING_MS: '-1' }),
		).toThrow('AIH_DROVR_EVERGREEN_SENDER_PACING_MS')
	})

	it('is what the evergreen sender paces with, for every send it drains', () => {
		const source = readFileSync(
			join(__dirname, 'drovr-evergreen-sender.ts'),
			'utf8',
		)
		expect(source).not.toContain('parseValuePathProviderPacingMs(')
		expect(
			source.match(/pacingMs: evergreenSenderPacingMs\(process\.env\)/g),
		).toHaveLength(3)
	})
})
