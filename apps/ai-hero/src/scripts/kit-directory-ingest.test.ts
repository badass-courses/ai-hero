import { describe, expect, it } from 'vitest'

import { parseCsvLine, subscriberFromCsvRow } from './kit-directory-ingest'

describe('kit directory export reader', () => {
	it('parses quoted commas and escaped quotes without touching the file path', () => {
		expect(parseCsvLine('42,"Doe, Jane","She said ""hi"""')).toEqual([
			'42',
			'Doe, Jane',
			'She said "hi"',
		])
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
