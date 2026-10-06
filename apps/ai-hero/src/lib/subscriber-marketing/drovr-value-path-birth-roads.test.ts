import { expect, it, vi } from 'vitest'
import {
	deliverDrovrShadowEventsDirect,
	emitDrovrShadowEvents,
	type DrovrShadowEvent,
} from './drovr-shadow-emitter'

const birth = (contactId: string): DrovrShadowEvent => ({
	tenantId: 'org-aihero',
	contactId,
	journeyId: 'value-path-skills-course',
	type: 'contact.created',
	occurredAt: '2026-10-05T10:00:00Z',
	idempotencyKey: `birth:${contactId}`,
})
const config = {
	ingestUrl: 'https://drovr.test/events',
	authorityApiKey: 'test-key',
}

it.each(['emit', 'fallback'])(
	'the %s direct road skips stopped births in a mixed batch',
	async (road) => {
		const fetcher = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response('{}', { status: 200 }),
		)
		const readBirthOptOuts = vi.fn(async () => ['stopped'])
		const info = vi.fn()
		const options = { config, fetch: fetcher, readBirthOptOuts, info }
		const events = [birth('stopped'), birth('active')]
		if (road === 'emit') await emitDrovrShadowEvents(events, options)
		else
			expect(await deliverDrovrShadowEventsDirect(events, options)).toEqual([])
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).contactId).toBe(
			'active',
		)
		expect(info).toHaveBeenCalledWith(
			'drovr.value_path.births_skipped_unsubscribed',
			{ count: 1, contactIds: ['stopped'] },
		)
	},
)

it('a fallback admission read failure throws before any POST, so dispatch can outbox the batch', async () => {
	const fetcher = vi.fn()
	await expect(
		deliverDrovrShadowEventsDirect([birth('c')], {
			config,
			fetch: fetcher,
			readBirthOptOuts: async () => {
				throw new Error('read unavailable')
			},
		}),
	).rejects.toThrow('read unavailable')
	expect(fetcher).not.toHaveBeenCalled()
})
