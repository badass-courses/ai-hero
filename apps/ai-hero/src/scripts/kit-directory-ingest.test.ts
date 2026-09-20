import { describe, expect, it } from 'vitest'

import {
	KIT_DIRECTORY_API_PAGE_SIZE,
	KIT_DIRECTORY_PAGE_DELAY_MS,
	readKitDirectoryPages,
	runKitDirectoryIngest,
	type KitDirectoryPageSummary,
} from './kit-directory-ingest'

function jsonResponse(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

type SentEvent = {
	data: {
		batch: unknown[]
		cursor?: string
		dryRun?: boolean
	}
}

describe('kit directory API reader', () => {
	it('walks cursor pages, maps subscribers, and paces requests', async () => {
		const pages = [
			{
				subscribers: [
					{
						id: 9,
						email_address: 'nine@example.test',
						first_name: 'Nine',
						state: 'active',
						created_at: '2026-09-20T00:00:00Z',
					},
				],
				pagination: { has_next_page: true, end_cursor: 'cursor-one' },
			},
			{
				subscribers: [
					{
						id: 10,
						email_address: 'ten@example.test',
						first_name: 'Ten',
						state: 'inactive',
						created_at: '2026-09-20T00:01:00Z',
					},
				],
				pagination: { has_next_page: false, end_cursor: 'cursor-two' },
			},
		]
		const requests: Array<{
			url: URL
			headers: HeadersInit | undefined
		}> = []
		let requestIndex = 0
		const fetcher: typeof fetch = async (input, init) => {
			requests.push({ url: new URL(String(input)), headers: init?.headers })
			return jsonResponse(pages[requestIndex++])
		}
		const sleeps: number[] = []
		const read = []

		for await (const page of readKitDirectoryPages({
			apiKey: 'test-kit-key',
			status: 'all',
			limit: 2,
			fetcher,
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds)
			},
		})) {
			read.push(page)
		}

		expect(requests).toHaveLength(2)
		expect(requests[0]?.url.search).toBe(
			`?status=all&per_page=${KIT_DIRECTORY_API_PAGE_SIZE}`,
		)
		expect(requests[1]?.url.search).toBe(
			`?status=all&per_page=${KIT_DIRECTORY_API_PAGE_SIZE}&after=cursor-one`,
		)
		expect(requests[0]?.headers).toMatchObject({
			'X-Kit-Api-Key': 'test-kit-key',
		})
		expect(sleeps).toEqual([KIT_DIRECTORY_PAGE_DELAY_MS])
		expect(read).toEqual([
			{
				page: 1,
				cursor: 'cursor-one',
				hasNextPage: true,
				subscribers: [
					{
						id: '9',
						email: 'nine@example.test',
						name: 'Nine',
						state: 'active',
						createdAt: '2026-09-20T00:00:00Z',
					},
				],
			},
			{
				page: 2,
				cursor: 'cursor-two',
				hasNextPage: false,
				subscribers: [
					{
						id: '10',
						email: 'ten@example.test',
						name: 'Ten',
						state: 'inactive',
						createdAt: '2026-09-20T00:01:00Z',
					},
				],
			},
		])
	})

	it('splits pages into bounded Inngest batches and preserves state', async () => {
		const sent: SentEvent[] = []
		const fetcher: typeof fetch = async (input, init) => {
			const url = new URL(String(input))
			if (url.hostname === 'api.kit.com') {
				return jsonResponse({
					subscribers: [
						{ id: 1, email_address: 'one@example.test', state: 'active' },
						{ id: 2, email_address: 'two@example.test', state: 'inactive' },
						{ id: 3, email_address: 'three@example.test', state: 'bounced' },
					],
					pagination: { has_next_page: false, end_cursor: 'last-cursor' },
				})
			}
			if (typeof init?.body !== 'string') throw new Error('Missing event body')
			sent.push(JSON.parse(init.body) as SentEvent)
			return jsonResponse({ accepted: true })
		}
		const summaries: KitDirectoryPageSummary[] = []

		const result = await runKitDirectoryIngest({
			apiKey: 'test-kit-key',
			status: 'all',
			batchSize: 2,
			limit: 1,
			send: true,
			write: false,
			eventKey: 'test-inngest-key',
			fetcher,
			onPage: (summary) => {
				summaries.push(summary)
			},
		})

		expect(sent).toHaveLength(2)
		expect(sent.map((event) => event.data.batch)).toEqual([
			[
				{ id: '1', email: 'one@example.test', state: 'active' },
				{ id: '2', email: 'two@example.test', state: 'inactive' },
			],
			[{ id: '3', email: 'three@example.test', state: 'bounced' }],
		])
		expect(sent.every((event) => event.data.cursor === 'last-cursor')).toBe(true)
		expect(sent.every((event) => event.data.dryRun === true)).toBe(true)
		expect(result).toMatchObject({
			pages: 1,
			subscribers: 3,
			batches: 2,
			sentBatches: 2,
			cursor: 'last-cursor',
		})
		expect(summaries).toEqual([
			{
				page: 1,
				subscribers: 3,
				batches: 2,
				sentBatches: 2,
				cursor: 'last-cursor',
			},
		])
	})
})
