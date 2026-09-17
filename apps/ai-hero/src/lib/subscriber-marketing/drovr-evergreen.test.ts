import { describe, expect, it } from 'vitest'

import {
	addSubscriberToKitSequence,
	readbackEvergreenListSequences,
	EVERGREEN_KIT_SEQUENCES,
	evergreenSequenceForMessage,
	parseDrovrEvergreenConfig,
	readbackEvergreenSequences,
} from './drovr-evergreen'

const readyEnv = {
	AIH_DROVR_EVERGREEN_ENABLED: 'true',
	DROVR_SHADOW_INGEST_URL: 'https://drovr.example/events',
	DROVR_API_KEY_ORG_AIHERO: 'key',
}

describe('evergreen Kit sequence table', () => {
	it('pins eight distinct slots to eight distinct sequences', () => {
		expect(EVERGREEN_KIT_SEQUENCES).toHaveLength(8)
		expect(new Set(EVERGREEN_KIT_SEQUENCES.map((e) => e.slot)).size).toBe(8)
		expect(new Set(EVERGREEN_KIT_SEQUENCES.map((e) => e.sequenceId)).size).toBe(
			8,
		)
		expect(evergreenSequenceForMessage('pitch_final_notice_v1')).toMatchObject({
			slot: 'P5',
			sequenceId: 2887686,
		})
		expect(evergreenSequenceForMessage('unknown')).toBeUndefined()
	})
})

describe('parseDrovrEvergreenConfig', () => {
	it('is off by default and says why', () => {
		expect(parseDrovrEvergreenConfig({})).toMatchObject({ enabled: false })
		expect(parseDrovrEvergreenConfig({}).reason).toContain(
			'AIH_DROVR_EVERGREEN_ENABLED',
		)
	})
	it('stays off when drovr itself is unreachable', () => {
		expect(
			parseDrovrEvergreenConfig({ AIH_DROVR_EVERGREEN_ENABLED: 'true' }),
		).toMatchObject({ enabled: false })
	})
	it('turns on with the flag and drovr configured', () => {
		expect(parseDrovrEvergreenConfig(readyEnv)).toEqual({ enabled: true })
	})
})

describe('readbackEvergreenSequences', () => {
	const sequenceJson = (
		id: number,
		name: string,
		overrides: Partial<Record<string, unknown>> = {},
	) =>
		new Response(
			JSON.stringify({
				sequence: {
					id,
					name,
					active: true,
					hold: false,
					repeat: false,
					email_count: 1,
					...overrides,
				},
			}),
			{ status: 200 },
		)
	const nameFor = (id: number) =>
		EVERGREEN_KIT_SEQUENCES.find((e) => e.sequenceId === id)!.messageId
	const emailsJson = (published: boolean[]) =>
		new Response(
			JSON.stringify({
				sequence_emails: published.map((p, i) => ({ id: i + 1, published: p })),
			}),
			{ status: 200 },
		)
	const isEmails = (url: string | URL | Request) =>
		String(url).endsWith('/emails')
	const idOf = (url: string | URL | Request) =>
		Number(
			String(url)
				.replace(/\/emails$/, '')
				.split('/')
				.pop(),
		)

	it('is ready when every sequence is active with exactly one email', async () => {
		const seen: string[] = []
		const result = await readbackEvergreenSequences({
			apiKey: 'k',
			fetch: (async (url: string | URL | Request, init?: RequestInit) => {
				seen.push(String(url))
				expect((init?.headers as Record<string, string>)['X-Kit-Api-Key']).toBe(
					'k',
				)
				if (isEmails(url)) return emailsJson([true])
				const id = idOf(url)
				return sequenceJson(id, `AIH Evergreen ${nameFor(id)}`)
			}) as typeof fetch,
			now: () => '2026-09-16T00:00:00.000Z',
		})
		expect(result).toEqual({
			ready: true,
			problems: [],
			checkedAt: '2026-09-16T00:00:00.000Z',
		})
		expect(seen).toHaveLength(16)
	})

	it('names every empty, inactive, held, or misnamed sequence', async () => {
		const result = await readbackEvergreenSequences({
			apiKey: 'k',
			fetch: (async (url: string | URL | Request) => {
				if (isEmails(url)) return emailsJson([true])
				const id = idOf(url)
				if (id === 2887679)
					return sequenceJson(id, nameFor(id), {
						email_count: 0,
						active: false,
					})
				if (id === 2887682) return sequenceJson(id, 'renamed', { hold: true })
				if (id === 2887686) return new Response('nope', { status: 500 })
				return sequenceJson(id, nameFor(id))
			}) as typeof fetch,
		})
		expect(result.ready).toBe(false)
		expect(result.problems).toEqual([
			'B1: sequence is not active',
			'B1: 0 emails, expected 1',
			'P1: sequence name lacks pitch_open_product_origin_v1',
			'P1: sequence is on hold',
			'P5: Kit answered 500',
		])
	})

	it('treats a lone draft email as not ready', async () => {
		const result = await readbackEvergreenSequences({
			apiKey: 'k',
			fetch: (async (url: string | URL | Request) => {
				if (isEmails(url)) return emailsJson([idOf(url) !== 2887680])
				const id = idOf(url)
				return sequenceJson(id, nameFor(id))
			}) as typeof fetch,
		})
		expect(result.ready).toBe(false)
		expect(result.problems).toEqual([
			'B2: 0 published of 1 emails, expected 1 of 1',
		])
	})

	it('refuses without a Kit key and never calls out', async () => {
		let calls = 0
		const result = await readbackEvergreenSequences({
			apiKey: undefined,
			fetch: (async () => {
				calls += 1
				return new Response('{}')
			}) as typeof fetch,
		})
		expect(result.ready).toBe(false)
		expect(calls).toBe(0)
	})
})

describe('addSubscriberToKitSequence', () => {
	it('posts the email to the sequence on the v4 key and reports added or already-added', async () => {
		const calls: { url: string; init?: RequestInit }[] = []
		const make = (status: number) =>
			(async (url: string | URL | Request, init?: RequestInit) => {
				calls.push({ url: String(url), init })
				return new Response(status === 204 ? null : '{}', { status })
			}) as typeof fetch
		await expect(
			addSubscriberToKitSequence({
				apiKey: 'k',
				fetch: make(201),
				sequenceId: 2887679,
				email: 'learner@example.com',
			}),
		).resolves.toBe('added')
		await expect(
			addSubscriberToKitSequence({
				apiKey: 'k',
				fetch: make(200),
				sequenceId: '2887679',
				email: 'learner@example.com',
			}),
		).resolves.toBe('already-added')
		expect(calls[0]?.url).toBe(
			'https://api.kit.com/v4/sequences/2887679/subscribers',
		)
		expect(calls[0]?.init?.method).toBe('POST')
		expect(
			(calls[0]?.init?.headers as Record<string, string>)['X-Kit-Api-Key'],
		).toBe('k')
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			email_address: 'learner@example.com',
		})
	})

	it('throws a KitV4Error carrying the status for anything else', async () => {
		await expect(
			addSubscriberToKitSequence({
				apiKey: 'k',
				fetch: (async () =>
					new Response('{"errors":["Sequence is inactive"]}', {
						status: 422,
					})) as typeof fetch,
				sequenceId: 2887679,
				email: 'learner@example.com',
			}),
		).rejects.toMatchObject({ name: 'KitV4Error', status: 422 })
		await expect(
			addSubscriberToKitSequence({
				apiKey: undefined,
				fetch: (async () => new Response('{}')) as typeof fetch,
				sequenceId: 2887679,
				email: 'learner@example.com',
			}),
		).rejects.toThrow('Kit v4 API key is not configured')
	})
})

describe('readbackEvergreenListSequences', () => {
	const answer = (overrides: Record<string, unknown>) =>
		(async () =>
			new Response(
				JSON.stringify({
					sequence: {
						id: 2625552,
						name: 'AI Hero Shadow Newsletter',
						active: true,
						hold: false,
						repeat: false,
						email_count: 13,
						...overrides,
					},
				}),
				{ status: 200 },
			)) as typeof fetch

	it('is ready when the newsletter sequence is active and off hold, however many emails it has', async () => {
		const result = await readbackEvergreenListSequences({
			apiKey: 'k',
			fetch: answer({ repeat: true }),
			now: () => '2026-09-16T00:00:00.000Z',
		})
		expect(result).toEqual({
			ready: true,
			problems: [],
			checkedAt: '2026-09-16T00:00:00.000Z',
		})
	})

	it('names an inactive or held sequence', async () => {
		const result = await readbackEvergreenListSequences({
			apiKey: 'k',
			fetch: answer({ active: false, hold: true }),
		})
		expect(result.ready).toBe(false)
		expect(result.problems).toEqual([
			'shadow-newsletter: sequence is not active',
			'shadow-newsletter: sequence is on hold',
		])
	})
})
