import { env } from '@/env.mjs'
import OpenAIProvider from '@coursebuilder/core/providers/openai'

export const openaiProvider = OpenAIProvider({
	apiKey: env.OPENAI_API_KEY,
	// PartyKit is gone; the OpenAI provider still requires a base URL.
	partyUrlBase: 'https://partykit.invalid',
})
