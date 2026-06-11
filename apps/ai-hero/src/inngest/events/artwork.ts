/**
 * Inngest events for the Slack-mediated artwork pipeline.
 *
 * Naming follows the codebase convention `<source>/<entity>.<verb>` —
 * `slack/...` events originate from Slack interactivity (button clicks,
 * slash commands, replay scripts); `artwork/...` events are internal
 * pipeline state transitions.
 */

export const ARTWORK_ACTION_IDS = {
	generate: 'artwork.generate',
	regenerate: 'artwork.regenerate',
	skip: 'artwork.skip',
	retry: 'artwork.retry',
	pickPrefix: 'artwork.pick.',
} as const

export const pickActionId = (variantIndex: number) =>
	`${ARTWORK_ACTION_IDS.pickPrefix}${variantIndex}` as const

export const SLACK_ARTWORK_GENERATE_REQUESTED_EVENT =
	'slack/artwork.generate.requested' as const
export type SlackArtworkGenerateRequested = {
	name: typeof SLACK_ARTWORK_GENERATE_REQUESTED_EVENT
	data: {
		postId: string
		channelId: string
		originalMessageTs: string
		/**
		 * Generated upstream (in the Slack route, slash command, or CLI)
		 * so generate-artwork can wait on artwork/fal.completed via the
		 * `match: 'data.batchId'` shortcut. Inngest's `if:` expression
		 * comparing async.data to a literal does NOT reliably resume the
		 * wait in 3.54.x — observed: event lands with the correct batchId
		 * but the wait still times out at 5min.
		 */
		batchId: string
		bypassGuards?: boolean
	}
}

export const SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT =
	'slack/artwork.regenerate.requested' as const
export type SlackArtworkRegenerateRequested = {
	name: typeof SLACK_ARTWORK_REGENERATE_REQUESTED_EVENT
	data: {
		postId: string
		channelId: string
		threadTs: string
		originalMessageTs: string
		/** New batchId for THIS regeneration run (matched on resume). */
		batchId: string
		/** Old batchId — used to supersede the prior thread message. */
		currentArtworkBatchId: string
		bypassGuards?: boolean
	}
}

export const SLACK_ARTWORK_PICK_REQUESTED_EVENT =
	'slack/artwork.pick.requested' as const
export type SlackArtworkPickRequested = {
	name: typeof SLACK_ARTWORK_PICK_REQUESTED_EVENT
	data: {
		postId: string
		channelId: string
		threadTs: string
		batchId: string
		variantIndex: number
		falUrl: string
		/** All variant URLs from the batch — used to re-render the thread message with options preserved (just minus the buttons) after Pick. */
		falUrls: string[]
		pickedByUserId: string
		originalMessageTs: string
	}
}

export const SLACK_ARTWORK_SKIP_REQUESTED_EVENT =
	'slack/artwork.skip.requested' as const
export type SlackArtworkSkipRequested = {
	name: typeof SLACK_ARTWORK_SKIP_REQUESTED_EVENT
	data: {
		postId: string
		channelId: string
		originalMessageTs: string
		skippedByUserId: string
	}
}

export const SLACK_ARTWORK_RETRY_REQUESTED_EVENT =
	'slack/artwork.retry.requested' as const
export type SlackArtworkRetryRequested = {
	name: typeof SLACK_ARTWORK_RETRY_REQUESTED_EVENT
	data: {
		postId: string
		channelId: string
		threadTs: string
		batchId: string
		originalMessageTs: string
		failureMessageTs: string
		retryStage: 'generate' | 'pick'
		pickedByUserId?: string
		variantIndex?: number
		falUrl?: string
	}
}

/**
 * Signal-only completion event from the fal webhook. Image URLs are NOT
 * carried here — generate-artwork re-fetches them from fal.queue.status to
 * defend against forged webhook payloads.
 */
export const ARTWORK_FAL_COMPLETED_EVENT = 'artwork/fal.completed' as const
export type ArtworkFalCompleted = {
	name: typeof ARTWORK_FAL_COMPLETED_EVENT
	data: {
		batchId: string
		postId: string
		falRequestId: string
	}
}

export const ARTWORK_GENERATION_FAILED_EVENT =
	'artwork/generation.failed' as const
export type ArtworkGenerationStage = 'llm' | 'fal' | 'cloudinary' | 'pick'
export type ArtworkGenerationFailed = {
	name: typeof ARTWORK_GENERATION_FAILED_EVENT
	data: {
		postId: string
		batchId: string | null
		channelId: string
		threadTs: string | null
		originalMessageTs: string
		stage: ArtworkGenerationStage
		errorMessage: string
		variantIndex?: number
		falUrl?: string
		pickedByUserId?: string
	}
}
