import { env } from '@/env.mjs'
import { signedTranscriptionCallbackUrl } from '@/lib/transcription-callback-signature'

import DeepgramProvider from '@coursebuilder/core/providers/deepgram'

export const transcriptProvider = DeepgramProvider({
	apiKey: env.DEEPGRAM_API_KEY,
	callbackUrl: `${env.COURSEBUILDER_URL}/api/coursebuilder/webhook/deepgram`,
	getCallbackUrl: signedTranscriptionCallbackUrl(env.NEXTAUTH_SECRET),
})
