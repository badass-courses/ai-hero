import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
	KIT_DIRECTORY_API_PAGE_SIZE,
	fetchKitDirectoryPage,
	KIT_DIRECTORY_MAX_RETRY_DELAY_MS,
	KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS,
	KIT_DIRECTORY_PAGE_DELAY_MS,
	parseKitDirectoryIngestArgs,
	readKitDirectoryPages,
	runKitDirectoryIngest,
	writeKitDirectoryRowsOnlyState,
	type KitDirectoryPageSummary,
} from './kit-directory-ingest'
import type { CaptureMarketingRepository } from '../lib/subscriber-marketing/capture-contact-event'
import type {
	ContactRecord,
	ProviderIdentityRecord,
} from '../lib/subscriber-marketing/types'

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

describe('kit directory CLI options', () => {
	it('parses rows-only as a direct write with an explicit state file', () => {
		expect(
			parseKitDirectoryIngestArgs([
				'--rows-only',
				'--state-file',
				'/tmp/kit-directory-state.json',
				'--after',
				'cursor-zero',
				'--limit',
				'1',
			]),
		).toMatchObject({
			rowsOnly: true,
			write: true,
			send: false,
			stateFile: '/tmp/kit-directory-state.json',
			after: 'cursor-zero',
			limit: 1,
		})
	})

	it('keeps write implying send and rejects rows-only with send', () => {
		expect(parseKitDirectoryIngestArgs(['--write'])).toMatchObject({
			write: true,
			send: true,
			rowsOnly: false,
		})
		expect(() =>
			parseKitDirectoryIngestArgs([
				'--rows-only',
				'--state-file',
				'/tmp/kit-directory-state.json',
				'--send',
			]),
		).toThrow('--rows-only cannot be combined with --send')
		expect(() => parseKitDirectoryIngestArgs(['--rows-only'])).toThrow(
			'--rows-only requires --state-file',
		)
	})
})

describe('rows-only cursor state', () => {
	it('atomically writes a resumable cursor receipt', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'kit-directory-state-'))
		const stateFile = join(directory, 'state.json')
		try {
			await writeKitDirectoryRowsOnlyState(stateFile, {
				version: 1,
				status: 'all',
				page: 1,
				cursor: 'cursor-one',
				subscribers: 3,
				createdRows: 2,
				alreadyPresentRows: 1,
				skippedInvalidRows: 0,
				failedRows: 0,
				failed: [],
				writeElapsedMs: 25,
				updatedAt: '2026-09-22T00:00:00.000Z',
			})

			expect(JSON.parse(await readFile(stateFile, 'utf8'))).toMatchObject({
				cursor: 'cursor-one',
				createdRows: 2,
				alreadyPresentRows: 1,
			})
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it('uses independent temp files for concurrent state writers', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'kit-directory-state-'))
		const stateFile = join(directory, 'state.json')
		const state = {
			version: 1 as const,
			status: 'all',
			page: 1,
			subscribers: 1,
			createdRows: 1,
			alreadyPresentRows: 0,
			skippedInvalidRows: 0,
			failedRows: 0,
			failed: [],
			writeElapsedMs: 10,
			updatedAt: '2026-09-22T00:00:00.000Z',
		}
		try {
			await Promise.all([
				writeKitDirectoryRowsOnlyState(stateFile, {
					...state,
					cursor: 'cursor-one',
				}),
				writeKitDirectoryRowsOnlyState(stateFile, {
					...state,
					cursor: 'cursor-two',
				}),
			])

			const written = JSON.parse(await readFile(stateFile, 'utf8')) as {
				cursor: string
			}
			expect(['cursor-one', 'cursor-two']).toContain(written.cursor)
			expect(await readdir(directory)).toEqual(['state.json'])
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})

describe('Kit pagination resilience', () => {
	it('retries network, 429, and 5xx responses while honoring Retry-After', async () => {
		const outcomes: Array<Response | Error> = [
			new Error('network unavailable'),
			new Response('{}', {
				status: 429,
				headers: { 'retry-after': '3' },
			}),
			new Response('{}', { status: 503 }),
			jsonResponse({
				subscribers: [{ id: 9 }],
				pagination: { has_next_page: false, end_cursor: 'cursor-nine' },
			}),
		]
		const fetchMock = vi.fn(
			async (
				_input: Parameters<typeof fetch>[0],
				_init?: Parameters<typeof fetch>[1],
			) => {
				const outcome = outcomes.shift()
				if (outcome instanceof Error) throw outcome
				if (!outcome) throw new Error('missing test outcome')
				return outcome
			},
		)
		const fetcher = fetchMock as unknown as typeof fetch
		const sleeps: number[] = []

		await expect(
			fetchKitDirectoryPage({
				apiKey: 'test-kit-key',
				status: 'all',
				fetcher,
				maxAttempts: 4,
				sleep: async (milliseconds) => {
					sleeps.push(milliseconds)
				},
			}),
		).resolves.toMatchObject({
			cursor: 'cursor-nine',
			subscribers: [{ id: '9' }],
		})
		expect(fetchMock).toHaveBeenCalledTimes(4)
		expect(sleeps).toEqual([1_000, 3_000, 4_000])
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
	})

	it('caps an oversized Retry-After instead of overflowing setTimeout', async () => {
		const responses = [
			new Response('{}', {
				status: 429,
				headers: { 'retry-after': '3000000' },
			}),
			jsonResponse({
				subscribers: [{ id: 10 }],
				pagination: { has_next_page: false, end_cursor: 'cursor-ten' },
			}),
		]
		const sleeps: number[] = []

		await fetchKitDirectoryPage({
			apiKey: 'test-kit-key',
			status: 'all',
			fetcher: async () => {
				const response = responses.shift()
				if (!response) throw new Error('missing test response')
				return response
			},
			maxAttempts: 2,
			sleep: async (milliseconds) => {
				sleeps.push(milliseconds)
			},
		})

		expect(sleeps).toEqual([KIT_DIRECTORY_MAX_RETRY_DELAY_MS])
	})

	it('rejects a request timeout above the safe setTimeout ceiling', async () => {
		const fetcher = vi.fn()

		await expect(
			fetchKitDirectoryPage({
				apiKey: 'test-kit-key',
				status: 'all',
				fetcher,
				requestTimeoutMs: KIT_DIRECTORY_MAX_RETRY_DELAY_MS + 1,
			}),
		).rejects.toThrow(
			`Kit request timeout must be an integer from ${KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS} to ${KIT_DIRECTORY_MAX_RETRY_DELAY_MS} milliseconds`,
		)
		expect(fetcher).not.toHaveBeenCalled()
	})

	it('aborts a Kit request at its deadline', async () => {
		vi.useFakeTimers()
		try {
			const fetcher: typeof fetch = async (_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new Error('aborted'))
					})
				})
			const assertion = expect(
				fetchKitDirectoryPage({
					apiKey: 'test-kit-key',
					status: 'all',
					fetcher,
					maxAttempts: 1,
					requestTimeoutMs: KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS,
				}),
			).rejects.toThrow('Kit API request failed after 1 attempts')

			await vi.advanceTimersByTimeAsync(KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS)
			await assertion
		} finally {
			vi.useRealTimers()
		}
	})

	it('keeps the deadline alive through body parsing and retries a stalled body', async () => {
		vi.useFakeTimers()
		try {
			let attempts = 0
			const sleeps: number[] = []
			const fetcher: typeof fetch = async (_input, init) => {
				attempts += 1
				if (attempts > 1) {
					return jsonResponse({
						subscribers: [{ id: 11 }],
						pagination: {
							has_next_page: false,
							end_cursor: 'cursor-eleven',
						},
					})
				}
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						init?.signal?.addEventListener('abort', () => {
							controller.error(new Error('body aborted'))
						})
					},
				})
				return new Response(body, {
					status: 200,
					headers: { 'content-type': 'application/json' },
				})
			}
			const result = fetchKitDirectoryPage({
				apiKey: 'test-kit-key',
				status: 'all',
				fetcher,
				maxAttempts: 2,
				requestTimeoutMs: KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS,
				sleep: async (milliseconds) => {
					sleeps.push(milliseconds)
				},
			})

			await vi.advanceTimersByTimeAsync(KIT_DIRECTORY_MIN_REQUEST_TIMEOUT_MS)
			await expect(result).resolves.toMatchObject({
				cursor: 'cursor-eleven',
				subscribers: [{ id: '11' }],
			})
			expect(attempts).toBe(2)
			expect(sleeps).toEqual([1_000])
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('rows-only Kit directory ingest', () => {
	const onePage: typeof fetch = async () =>
		jsonResponse({
			subscribers: [{ id: 1 }, { id: 2 }, { id: 3 }],
			pagination: { has_next_page: false, end_cursor: 'cursor-three' },
		})

	it('writes through the library without an Inngest request', async () => {
		const requestedHosts: string[] = []
		const fetcher: typeof fetch = async (input) => {
			requestedHosts.push(new URL(String(input)).hostname)
			return onePage(input)
		}
		const ingestBatch = vi.fn(
			async ({ batch }: { batch: readonly unknown[] }) => ({
				mode: 'write' as const,
				counts: {
					processed: batch.length,
					created: batch.length,
					alreadyPresent: 0,
					wouldCreate: 0,
					skippedInvalid: 0,
					failed: 0,
				},
				failed: [],
			}),
		)
		const onPage = vi.fn()

		const result = await runKitDirectoryIngest({
			apiKey: 'test-kit-key',
			status: 'all',
			batchSize: 2,
			limit: 1,
			send: false,
			write: true,
			rowsOnly: true,
			repository: {} as CaptureMarketingRepository,
			fetcher,
			ingestBatch,
			onPage,
		})

		expect(requestedHosts).toEqual(['api.kit.com'])
		expect(ingestBatch).toHaveBeenCalledTimes(2)
		for (const [args] of ingestBatch.mock.calls) {
			expect(args).toMatchObject({
				dryRun: false,
				suppressBirthDelivery: true,
			})
		}
		expect(result).toMatchObject({
			pages: 1,
			subscribers: 3,
			batches: 2,
			sentBatches: 0,
			createdRows: 3,
			cursor: 'cursor-three',
		})
		expect(onPage).toHaveBeenCalledOnce()
	})

	it('does not advance the state callback until every batch succeeds', async () => {
		const ingestBatch = vi
			.fn()
			.mockResolvedValueOnce({
				mode: 'write',
				counts: {
					processed: 1,
					created: 1,
					alreadyPresent: 0,
					wouldCreate: 0,
					skippedInvalid: 0,
					failed: 0,
				},
				failed: [],
			})
			.mockRejectedValueOnce(new Error('second batch failed'))
		const onPage = vi.fn()

		await expect(
			runKitDirectoryIngest({
				apiKey: 'test-kit-key',
				status: 'all',
				batchSize: 1,
				limit: 1,
				send: false,
				write: true,
				rowsOnly: true,
				repository: {} as CaptureMarketingRepository,
				fetcher: onePage,
				ingestBatch,
				onPage,
			}),
		).rejects.toThrow('second batch failed')
		expect(onPage).not.toHaveBeenCalled()
	})

	it('finishes the page before exiting with failed provider ids', async () => {
		const ingestBatch = vi
			.fn()
			.mockResolvedValueOnce({
				mode: 'write',
				counts: {
					processed: 2,
					created: 1,
					alreadyPresent: 0,
					wouldCreate: 0,
					skippedInvalid: 0,
					failed: 1,
				},
				failed: ['2'],
			})
			.mockResolvedValueOnce({
				mode: 'write',
				counts: {
					processed: 1,
					created: 1,
					alreadyPresent: 0,
					wouldCreate: 0,
					skippedInvalid: 0,
					failed: 0,
				},
				failed: [],
			})
		const onPage = vi.fn()

		await expect(
			runKitDirectoryIngest({
				apiKey: 'test-kit-key',
				status: 'all',
				batchSize: 2,
				limit: 1,
				send: false,
				write: true,
				rowsOnly: true,
				repository: {} as CaptureMarketingRepository,
				fetcher: onePage,
				ingestBatch,
				onPage,
			}),
		).rejects.toThrow('Rows-only page 1 failed for Kit provider ids: 2')
		expect(ingestBatch).toHaveBeenCalledTimes(2)
		expect(onPage).toHaveBeenCalledWith(
			expect.objectContaining({ failedRows: 1, failed: ['2'] }),
		)
	})

	it('is idempotent when a restart repeats the last source page', async () => {
		const identities = new Map<string, ProviderIdentityRecord>()
		const contacts = new Map<string, ContactRecord>()
		const repository = {
			findProviderIdentity: async (_provider: string, externalId: string) =>
				identities.get(externalId),
			findContactById: async (id: string) => contacts.get(id),
			createContactAndProviderIdentity: async (
				input: Omit<ContactRecord, 'id'>,
				identityInput: Omit<ProviderIdentityRecord, 'id' | 'contactId'>,
			) => {
				const contact = { ...input, id: `contact-${identityInput.externalId}` }
				const identity = {
					...identityInput,
					id: `identity-${identityInput.externalId}`,
					contactId: contact.id,
				}
				contacts.set(contact.id, contact)
				identities.set(identity.externalId, identity)
				return {
					contact,
					providerIdentity: identity,
					createdContact: true,
					createdProviderIdentity: true,
				}
			},
		} as unknown as CaptureMarketingRepository
		const args = {
			apiKey: 'test-kit-key',
			status: 'all',
			batchSize: 500,
			limit: 1,
			send: false,
			write: true,
			rowsOnly: true,
			repository,
			fetcher: async () =>
				jsonResponse({
					subscribers: [{ id: 7 }],
					pagination: { has_next_page: false, end_cursor: 'cursor-seven' },
				}),
		} as const

		const first = await runKitDirectoryIngest(args)
		const restarted = await runKitDirectoryIngest({
			...args,
			after: 'cursor-before-seven',
		})

		expect(first).toMatchObject({ createdRows: 1, alreadyPresentRows: 0 })
		expect(restarted).toMatchObject({ createdRows: 0, alreadyPresentRows: 1 })
		expect(contacts).toHaveLength(1)
		expect(identities).toHaveLength(1)
	})
})
