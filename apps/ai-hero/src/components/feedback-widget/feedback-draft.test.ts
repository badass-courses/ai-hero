import { describe, expect, it } from 'vitest'

import {
	clearFeedbackDraft,
	FEEDBACK_DRAFT_KEY,
	readFeedbackDraft,
	writeFeedbackDraft,
} from './feedback-draft'

function memoryStorage() {
	const map = new Map<string, string>()
	return {
		map,
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
	}
}

describe('feedback draft', () => {
	it('keeps typed text across a close and reopen', () => {
		const storage = memoryStorage()
		writeFeedbackDraft('half a thought', storage)
		expect(readFeedbackDraft(storage)).toBe('half a thought')
	})

	it('drops the draft when the text is emptied', () => {
		const storage = memoryStorage()
		writeFeedbackDraft('something', storage)
		writeFeedbackDraft('   ', storage)
		expect(storage.map.has(FEEDBACK_DRAFT_KEY)).toBe(false)
	})

	it('clears after a send', () => {
		const storage = memoryStorage()
		writeFeedbackDraft('sent text', storage)
		clearFeedbackDraft(storage)
		expect(readFeedbackDraft(storage)).toBe('')
	})

	it('survives blocked storage', () => {
		const throwing = {
			getItem: () => {
				throw new Error('blocked')
			},
			setItem: () => {
				throw new Error('blocked')
			},
			removeItem: () => {
				throw new Error('blocked')
			},
		}
		expect(() => writeFeedbackDraft('x', throwing)).not.toThrow()
		expect(readFeedbackDraft(throwing)).toBe('')
		expect(() => clearFeedbackDraft(throwing)).not.toThrow()
	})
})
