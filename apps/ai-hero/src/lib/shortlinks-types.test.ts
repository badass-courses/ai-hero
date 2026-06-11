import { describe, expect, it } from 'vitest'

import {
	CreateShortlinkSchema,
	ShortlinkMetadataSchema,
	UpdateShortlinkSchema,
} from './shortlinks-types'

const validMetadata = {
	schemaVersion: 1,
	campaign: 'cohort_004',
	campaignPhase: 'warmup',
	sourceSurface: 'broadcast',
	sourceId: 'cc004_warmup_01',
	contentSlug: 'agentic-workflows-real-code',
	contentTopic: 'ai_workflow',
	contentIntent: 'problem_aware',
	valuePath: 'ai_coding_workflow',
	createdFor: 'campaign',
}

describe('ShortlinkMetadataSchema', () => {
	it('accepts the v1 flat metadata shape', () => {
		expect(ShortlinkMetadataSchema.parse(validMetadata)).toEqual(validMetadata)
	})

	it('rejects arbitrary nested data', () => {
		expect(() =>
			ShortlinkMetadataSchema.parse({
				...validMetadata,
				extra: { nested: true },
			}),
		).toThrow()
	})

	it('rejects invalid bounded values', () => {
		expect(() =>
			ShortlinkMetadataSchema.parse({
				...validMetadata,
				campaignPhase: 'launching',
			}),
		).toThrow()
	})

	it('accepts campaign metadata without content fields', () => {
		const { contentSlug, contentTopic, contentIntent, valuePath, ...metadata } =
			validMetadata

		expect(ShortlinkMetadataSchema.parse(metadata)).toEqual(metadata)
	})

	it('rejects unbounded freeform identifiers', () => {
		expect(() =>
			ShortlinkMetadataSchema.parse({
				...validMetadata,
				campaign: 'Cohort 004 launch notes',
			}),
		).toThrow()
	})
})

describe('shortlink create and update schemas', () => {
	it('accept create payloads with metadata', () => {
		expect(
			CreateShortlinkSchema.parse({
				slug: 'cc004-warmup-01',
				url: 'https://www.aihero.dev/articles/agentic-workflows-real-code',
				metadata: validMetadata,
			}),
		).toMatchObject({ metadata: validMetadata })
	})

	it('accepts null metadata for backward-compatible updates', () => {
		expect(
			UpdateShortlinkSchema.parse({
				id: 'shortlink_123',
				metadata: null,
			}),
		).toEqual({ id: 'shortlink_123', metadata: null })
	})
})
