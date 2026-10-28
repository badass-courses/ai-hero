import { MockPartykitProvider } from '@coursebuilder/core/providers/partykit'

/**
 * The managed PartyKit host (ai-hero.skillrecordings.partykit.dev) no longer
 * resolves. The core video and Mux Inngest functions await
 * `partyProvider.broadcastMessage` inside a step; a throwing broadcast fails
 * them before they send downstream events (transcript order, uploadthing
 * cleanup). Nothing in the app reads those broadcasts, so use the core no-op.
 */
export const partyProvider = MockPartykitProvider
