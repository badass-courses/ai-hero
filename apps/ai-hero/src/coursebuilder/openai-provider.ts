import { MockOpenAIProvider } from '@coursebuilder/core/providers/openai'

// The only consumer of a live OpenAI provider was the resource-chat workflow
// that streamed to PartyKit; nothing sends its event.
export const openaiProvider = MockOpenAIProvider
