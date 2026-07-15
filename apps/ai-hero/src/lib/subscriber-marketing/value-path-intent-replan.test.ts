import { describe, expect, it, vi } from 'vitest'

import { replanBlockedValuePathEmailIntents } from './value-path-intent-replan'
import type { SideEffectIntent } from './types'

const blocked = (id: string): SideEffectIntent => ({
	id,
	nextActionId: `${id}-action`,
	contactId: 'contact-1',
	provider: 'kit',
	type: 'send-value-path-email',
	status: 'blocked',
	idempotencyKey: id,
	gates: [],
	reviewReasons: ['old-block'],
	metadata: { emailResourceId: `path.${id}` },
	createdAt: '2026-07-15T10:00:00.000Z',
})

describe('value path intent replan', () => {
	it('replans only the explicitly classified blocked intent', async () => {
		const intents = [blocked('intent-current'), blocked('intent-old')]
		const updateSideEffectIntent = vi.fn()
		const result = await replanBlockedValuePathEmailIntents({
			repository: {
				findValuePathEmailSideEffectIntentsByContact: () => intents,
				updateSideEffectIntent,
			},
			contactIds: ['contact-1'],
			intentIds: ['intent-current'],
			allowWrite: true,
			now: '2026-07-15T12:00:00.000Z',
		})
		expect(result.counts).toMatchObject({ blockedIntentsFound: 1, replanned: 1 })
		expect(updateSideEffectIntent).toHaveBeenCalledTimes(1)
		expect(updateSideEffectIntent.mock.calls[0]?.[0]).toBe('intent-current')
})
})
