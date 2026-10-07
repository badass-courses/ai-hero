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

	it.each([429, 502, 503, 504])(
		'preserves Retry-After on %s, never interpreting a missing-looking body as absence',
		async (status) => {
			const fetcher = vi.fn(
				async () =>
					new Response(
						JSON.stringify({ type: 'urn:drovr:problem:contact-not-found' }),
						{ status, headers: { 'retry-after': '7' } },
					),
			)
			expect(
				await readDrovrContactActor({
					contactId: 'c1',
					journeyId: 'value-path-skills-course',
					config,
					fetcher,
				}),
			).toEqual({
				ok: false,
				reason: `drovr answered ${status}`,
				backpressure: { status, retryAfter: '7' },
			})
		},
	)

	it.each(['AbortError', 'TimeoutError'])(
		'treats %s as shedding, never absence',
		async (name) => {
			const fetcher = vi
				.fn()
				.mockRejectedValue(new DOMException('read timed out', name))
			expect(
				await readDrovrContactActor({
					contactId: 'c1',
					journeyId: 'journey',
					config,
					fetcher,
					timeoutMs: 5,
				}),
			).toMatchObject({ ok: false, backpressure: { status: 'timeout' } })
		},
	)

	it('turns its real abort deadline into shedding even when the fetch error has a generic name', async () => {
		const fetcher = vi.fn<typeof fetch>(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => reject(new Error('owned read timed out')),
						{ once: true },
					)
				}),
		)
		expect(
			await readDrovrContactActor({
				contactId: 'c1',
				journeyId: 'journey',
				config,
				fetcher,
				timeoutMs: 5,
			}),
		).toMatchObject({ ok: false, backpressure: { status: 'timeout' } })
	})

	it('does not swallow an abort while decoding a success body', async () => {
		const response = new Response('{}', { status: 200 })
		vi.spyOn(response, 'json').mockRejectedValue(
			new DOMException('body timed out', 'AbortError'),
		)
		const fetcher = vi.fn(async () => response)
		expect(
			await readDrovrContactActor({
				contactId: 'c1',
				journeyId: 'journey',
				config,
				fetcher,
			}),
		).toMatchObject({ ok: false, backpressure: { status: 'timeout' } })
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
