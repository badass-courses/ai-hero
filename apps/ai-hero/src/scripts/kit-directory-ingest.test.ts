import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
	parseCsvLine,
	readKitDirectoryBatches,
	subscriberFromCsvRow,
} from './kit-directory-ingest'

describe('kit directory export reader', () => {
	it('parses quoted commas and escaped quotes without touching the file path', () => {
		expect(parseCsvLine('42,"Doe, Jane","She said ""hi"""')).toEqual([
			'42',
			'Doe, Jane',
			'She said "hi"',
		])
	})

	it('filters --after numerically so Kit id 10 survives after id 9', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'kit-directory-ingest-'))
		const file = join(directory, 'subscribers.csv')
		try {
			await writeFile(file, 'id\n9\n10\n', 'utf8')
			const subscribers = []
			for await (const batch of readKitDirectoryBatches(file, {
				after: '9',
				batchSize: 500,
			})) {
				subscribers.push(...batch)
			}

			expect(subscribers.map((subscriber) => subscriber.id)).toEqual(['10'])
		} finally {
			await rm(directory, { recursive: true, force: true })
		}
	})

	it('accepts common Kit export headers and omits missing optional fields', () => {
		expect(
			subscriberFromCsvRow(
				['subscriberid', 'emailaddress', 'firstname', 'lastname', 'createdat'],
				['42', 'person@example.test', 'Jane', 'Doe', '2026-09-20T00:00:00Z'],
			),
		).toEqual({
			id: '42',
			email: 'person@example.test',
			name: 'Jane Doe',
			createdAt: '2026-09-20T00:00:00Z',
		})
	})

	it('drops rows without a Kit subscriber id', () => {
		expect(
			subscriberFromCsvRow(['email', 'name'], ['person@example.test', 'No ID']),
		).toBeUndefined()
	})
})
