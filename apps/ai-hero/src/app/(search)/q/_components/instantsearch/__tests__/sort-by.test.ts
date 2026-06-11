import { describe, expect, it } from 'vitest'

import { TYPESENSE_COLLECTION_NAME } from '@/utils/typesense-instantsearch-adapter'

import { sortOptions } from '../sort-options'

const BUCKETED = `_text_match(buckets:10):desc`

describe('sortOptions', () => {
	it('exposes exactly four options', () => {
		expect(sortOptions).toHaveLength(4)
	})

	it('uses user-facing labels in the expected order', () => {
		expect(sortOptions.map((o) => o.label)).toEqual([
			'Newest first',
			'Most Popular',
			'Relevance',
			'Oldest first',
		])
	})

	it('makes Newest the default (first option)', () => {
		expect(sortOptions[0]?.label).toBe('Newest first')
		expect(sortOptions[0]?.value).toBe(
			`${TYPESENSE_COLLECTION_NAME}/sort/${BUCKETED},created_at_timestamp:desc`,
		)
	})

	it('uses bucketed text-match + popularity tiebreaker for Most Popular', () => {
		const mostPopular = sortOptions.find((o) => o.label === 'Most Popular')
		expect(mostPopular?.value).toBe(
			`${TYPESENSE_COLLECTION_NAME}/sort/${BUCKETED},popularity_30d:desc`,
		)
	})

	it('uses bucketed text-match + recency tiebreaker for Newest and Oldest', () => {
		const newest = sortOptions.find((o) => o.label === 'Newest first')
		const oldest = sortOptions.find((o) => o.label === 'Oldest first')
		expect(newest?.value).toContain(BUCKETED)
		expect(newest?.value).toContain('created_at_timestamp:desc')
		expect(oldest?.value).toContain(BUCKETED)
		expect(oldest?.value).toContain('created_at_timestamp:asc')
	})

	it('keeps Relevance as the raw text-match sort (collection name only, no buckets)', () => {
		const relevance = sortOptions.find((o) => o.label === 'Relevance')
		expect(relevance?.value).toBe(TYPESENSE_COLLECTION_NAME)
	})
})
