import { contactEvent } from '@/db/schema'

/**
 * The disabled sequence-exhaustion slice uses the base Contact Event table.
 * Semantic identity and typed payload data live in its existing fields. The
 * additive schema batch adds only the bounded event-time access path.
 */
export const courseSequenceContactEvent = contactEvent
