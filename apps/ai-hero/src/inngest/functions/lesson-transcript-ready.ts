import { revalidateTag } from 'next/cache'
import { LESSON_TRANSCRIPT_TAG } from '@/lib/lesson-transcript-cache'

import { VIDEO_TRANSCRIPT_READY_EVENT } from '@coursebuilder/core/events/video'

import { inngest } from '../inngest.server'

export const lessonTranscriptReady = inngest.createFunction(
	{ id: 'lesson-transcript-cache-invalidation' },
	{ event: VIDEO_TRANSCRIPT_READY_EVENT },
	async ({ step }) => {
		// Course Builder emits this event after persisting the transcript.
		await step.run('revalidate lesson transcript cache', async () => {
			revalidateTag(LESSON_TRANSCRIPT_TAG, 'max')
		})
	},
)
