import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	deleteDocuments: vi.fn(),
	getAiCodingDictionary: vi.fn(),
	importDocuments: vi.fn(),
	logError: vi.fn(),
	logInfo: vi.fn(),
	logWarn: vi.fn(),
}))

vi.mock('@/server/logger', () => ({
	log: {
		error: mocks.logError,
		info: mocks.logInfo,
		warn: mocks.logWarn,
	},
}))

vi.mock('./ai-coding-dictionary', () => ({
	AI_CODING_DICTIONARY_DESCRIPTION: 'Dictionary description',
	AI_CODING_DICTIONARY_TITLE: 'AI Coding Dictionary',
	getAiCodingDictionary: mocks.getAiCodingDictionary,
	stripMarkdown: (markdown: string) => markdown,
}))

vi.mock('typesense', () => ({
	default: {
		Client: class {
			collections() {
				return {
					documents: () => ({
						delete: mocks.deleteDocuments,
						import: mocks.importDocuments,
					}),
				}
			}
		},
	},
}))

import { indexAiCodingDictionaryToTypesense } from './ai-coding-dictionary-typesense'

describe('indexAiCodingDictionaryToTypesense', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.stubEnv('NEXT_PUBLIC_TYPESENSE_HOST', 'search.example.com')
		vi.stubEnv('TYPESENSE_WRITE_API_KEY', 'write-key')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('keeps existing documents when the dictionary source cannot be loaded', async () => {
		const sourceError = new Error('dictionary source unavailable')
		mocks.getAiCodingDictionary.mockRejectedValue(sourceError)

		await expect(indexAiCodingDictionaryToTypesense()).rejects.toBe(sourceError)

		expect(mocks.deleteDocuments).not.toHaveBeenCalled()
		expect(mocks.importDocuments).not.toHaveBeenCalled()
	})
})
