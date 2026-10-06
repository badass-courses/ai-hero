import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { evergreenSenderPacingMs } from './evergreen-sender-pacing'
import { parseNewsletterSenderConfig } from './newsletter-sender-config'
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

	it('keeps list/evergreen pacing and wires newsletter opt-in plus the legacy fallback', () => {
		const source = readFileSync(
			join(__dirname, 'drovr-evergreen-sender.ts'),
			'utf8',
		)
		expect(source).not.toContain('parseValuePathProviderPacingMs(')
		const site = (start: string, end: string) => {
			const from = source.indexOf(start)
			const to = source.indexOf(end, from)
			expect(from).toBeGreaterThanOrEqual(0)
			expect(to).toBeGreaterThan(from)
			return source.slice(from, to)
		}
		const lists = site("step.run('subscribe-pending-evergreen-lists'", 'const shadowReadback')
		const evergreen = site("step.run('send-pending-evergreen-emails'", 'const coupons')
		for (const unchanged of [lists, evergreen]) {
			expect(unchanged).toContain('pacingMs: evergreenSenderPacingMs(process.env)')
			expect(unchanged).not.toContain('newsletter.pacingMs')
		}
		expect(
			source.match(/pacingMs: evergreenSenderPacingMs\(process\.env\)/g),
		).toHaveLength(2)
		const shadow = site("step.run('send-pending-shadow-newsletter-emails'", 'const newsletterQueue')
		expect(shadow).toContain('type: SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE')
		expect(shadow).toMatch(/pacingMs:\s*newsletter\.mode === 'opt-in'\s*\? newsletter\.pacingMs\s*:\s*evergreenSenderPacingMs\(process\.env\)/)
		expect(source).toContain('pacingMs: process.env.AIH_DROVR_NEWSLETTER_PACING_MS')
		expect(source).toContain('limit: process.env.AIH_DROVR_NEWSLETTER_LIMIT')

		// Exercise the actual parser; the source assertion above ties this
		// discriminant to the production site's dedicated/legacy selection.
		const inheritedEnv = { AIH_DROVR_EVERGREEN_SENDER_PACING_MS: '3000' }
		for (const pacingMs of [undefined, '2000']) {
			const config = parseNewsletterSenderConfig({
				pacingMs, limit: undefined, inheritLimit: () => 25,
				inheritPacingMs: () => evergreenSenderPacingMs(inheritedEnv),
			})
			expect(config.mode).toBe(pacingMs === undefined ? 'legacy' : 'opt-in')
			expect(config.mode === 'opt-in' ? config.pacingMs : evergreenSenderPacingMs(inheritedEnv))
				.toBe(pacingMs === undefined ? 3000 : 2000)
		}
	})
})
