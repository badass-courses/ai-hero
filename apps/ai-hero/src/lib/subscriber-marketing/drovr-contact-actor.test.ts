import { describe, expect, it, vi } from 'vitest'

import { readDrovrContactActor } from './drovr-contact-actor'

const config = { baseUrl: 'https://drovr.test/', apiKey: 'tenant-key' }
const answer = (body: unknown, status = 200) =>
	vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))

describe("drovr's contact actor read (GET /contacts)", () => {
	it('asks for one contact on one journey with the tenant key', async () => {
		const fetcher = answer({
			journeyId: 'value-path-skills-course',
			journeyVersion: 2,
			retries: [],
			state: { email1: 'waiting' },
			stateName: 'email1.waiting',
			wakes: [],
		})
		await expect(
			readDrovrContactActor({
				contactId: 'c 1',
				journeyId: 'value-path-skills-course',
				config,
				fetcher,
			}),
		).resolves.toEqual({ ok: true, found: true, stateName: 'email1.waiting' })
		expect(fetcher).toHaveBeenCalledWith(
			'https://drovr.test/contacts?contact=c%201&journey=value-path-skills-course',
			expect.objectContaining({
				method: 'GET',
				headers: {
					accept: 'application/json',
					authorization: 'Bearer tenant-key',
				},
			}),
		)
	})

	it('reads 404 contact-not-found as no actor snapshot', async () => {
		await expect(
			readDrovrContactActor({
				contactId: 'c1',
				journeyId: 'value-path-skills-course',
				config,
				fetcher: answer(
					{
						type: 'urn:drovr:problem:contact-not-found',
						title: 'Contact actor not found',
						status: 404,
					},
					404,
				),
			}),
		).resolves.toEqual({ ok: true, found: false })
	})

	it.each([
		[
			'a 404 for an unknown journey',
			answer({ type: 'urn:drovr:problem:unknown-journey' }, 404),
		],
		['a 500', answer({ type: 'urn:drovr:problem:internal' }, 500)],
		['a 200 without a state name', answer({ journeyId: 'x' })],
		[
			'a transport error',
			vi.fn().mockRejectedValue(new Error('socket hang up')),
		],
	])('never guesses: %s is unreadable', async (_name, fetcher) => {
		const read = await readDrovrContactActor({
			contactId: 'c1',
			journeyId: 'value-path-skills-course',
			config,
			fetcher,
		})
		expect(read.ok).toBe(false)
	})

	it('is unreadable without configuration', async () => {
		const fetcher = vi.fn()
		await expect(
			readDrovrContactActor({
				contactId: 'c1',
				journeyId: 'value-path-skills-course',
				config: { baseUrl: undefined, apiKey: 'k' },
				fetcher,
			}),
		).resolves.toMatchObject({ ok: false })
		expect(fetcher).not.toHaveBeenCalled()
	})
})
