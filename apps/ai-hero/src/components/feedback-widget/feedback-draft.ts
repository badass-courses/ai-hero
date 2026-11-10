/**
 * Keeps the feedback text a reader has typed so closing the dialog, by
 * accident or on purpose, does not lose it. Cleared after a successful send.
 */
export const FEEDBACK_DRAFT_KEY = 'aih-feedback-draft-v1'

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStorage(): DraftStorage | undefined {
	try {
		return typeof window === 'undefined' ? undefined : window.localStorage
	} catch {
		return undefined
	}
}

export function readFeedbackDraft(
	storage: DraftStorage | undefined = browserStorage(),
): string {
	try {
		return storage?.getItem(FEEDBACK_DRAFT_KEY) ?? ''
	} catch {
		return ''
	}
}

export function writeFeedbackDraft(
	text: string,
	storage: DraftStorage | undefined = browserStorage(),
): void {
	try {
		if (text.trim()) storage?.setItem(FEEDBACK_DRAFT_KEY, text)
		else storage?.removeItem(FEEDBACK_DRAFT_KEY)
	} catch {
		// Storage full or blocked: the draft just isn't kept.
	}
}

export function clearFeedbackDraft(
	storage: DraftStorage | undefined = browserStorage(),
): void {
	try {
		storage?.removeItem(FEEDBACK_DRAFT_KEY)
	} catch {
		// Nothing to clear.
	}
}
