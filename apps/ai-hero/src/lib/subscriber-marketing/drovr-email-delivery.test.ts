import { describe, expect, it, vi } from 'vitest'

import { readDrovrEmailDelivery } from './drovr-email-delivery'

const config = { baseUrl: 'https://drovr.test', apiKey: 'tenant-key' }
const answer = (body: unknown, status = 200) =>
	vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))

describe('drovr get_email_delivery read (drovr #412)', () => {
	it('asks GET /email-delivery for the contact and email with the tenant key', async () => {
		const fetcher = answer({
			status: 'delivered',
			route: 'postshiba',
			deliveredAt: '2026-09-26T15:07:42.000Z',
			provider: 'postshiba',
			contactId: 'c1',
			email: 'ai-hero-skills-workflow.email-0',
			journeyId: 'value-path-skills-course',
		})
		await expect(
			readDrovrEmailDelivery({
				contactId: 'c1',
				email: 'ai-hero-skills-workflow.email-0',
				config,
				fetcher,
			}),
		).resolves.toEqual({
			ok: true,
			delivery: {
				status: 'delivered',
				route: 'postshiba',
				deliveredAt: '2026-09-26T15:07:42.000Z',
				provider: 'postshiba',
			},
		})
		expect(fetcher).toHaveBeenCalledWith(
			'https://drovr.test/email-delivery?contact=c1&email=ai-hero-skills-workflow.email-0',
			expect.objectContaining({
				method: 'GET',
				headers: {
					accept: 'application/json',
					authorization: 'Bearer tenant-key',
				},
			}),
		)
	})

	it('reads each of the four answers', async () => {
		for (const status of [
			'delivered',
			'pending',
			'not-routed',
			'not-started',
		] as const) {
			const result = await readDrovrEmailDelivery({
				contactId: 'c1',
				email: 'ai-hero-skills-workflow.email-0',
				config,
				fetcher: answer({
					status,
					route: null,
					deliveredAt: null,
					provider: null,
				}),
			})
			expect(result).toMatchObject({ ok: true, delivery: { status } })
		}
	})

	it('never guesses: an error, a refusal, an unknown shape or no config is unreadable', async () => {
		const read = (fetcher: typeof fetch, cfg = config) =>
			readDrovrEmailDelivery({
				contactId: 'c1',
				email: 'ai-hero-skills-workflow.email-0',
				config: cfg,
				fetcher,
			})
		await expect(
			read(answer({ type: 'contact-read-failure' }, 500)),
		).resolves.toEqual({ ok: false, reason: 'drovr answered 500' })
		await expect(
			read(answer({ type: 'malformed-email-delivery-query' }, 400)),
		).resolves.toEqual({ ok: false, reason: 'drovr answered 400' })
		await expect(read(answer({ status: 'maybe' }))).resolves.toEqual({
			ok: false,
			reason: 'drovr answered an unknown delivery shape',
		})
		await expect(
			read(vi.fn().mockRejectedValue(new Error('socket hang up'))),
		).resolves.toEqual({ ok: false, reason: 'socket hang up' })
		await expect(
			read(vi.fn(), { baseUrl: undefined, apiKey: 'k' } as never),
		).resolves.toEqual({ ok: false, reason: 'drovr is not configured' })
	})
})
