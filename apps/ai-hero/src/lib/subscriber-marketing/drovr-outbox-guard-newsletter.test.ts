import { describe, expect, it, vi } from 'vitest'

import { isMysqlMissingTableError } from './drovr-outbox-drizzle'
import { fanOutOwnedEvents } from './drovr-ownership'
import {
	DROVR_EVERGREEN_OFFER_JOURNEY_ID,
	mapDrovrShadowFact,
} from './drovr-shadow-emitter'
import { newsletterOwnerBirthOf } from './owner-birth-guard-drizzle'
import type { SideEffectIntent } from './types'

vi.mock('@/env.mjs', () => ({ env: {} }))

const intent = (metadata: Record<string, unknown> = {}): SideEffectIntent =>
	({
		id: 'intent-1',
		nextActionId: 'next-1',
		contactId: 'c1',
		provider: 'kit',
		type: 'subscribe-evergreen-list',
		status: 'completed',
		completedAt: '2026-09-29T10:00:00.000Z',
		idempotencyKey: 'intent-key-1',
		gates: [],
		reviewReasons: [],
		metadata: {
			list: 'shadow-newsletter',
			timezone: 'Asia/Tokyo',
			timezoneSource: 'vercel-header',
			drovr: {
				tenantId: 'org-aihero',
				intentKey: 'drovr-intent-1',
				journeyId: DROVR_EVERGREEN_OFFER_JOURNEY_ID,
			},
			...metadata,
		},
		createdAt: '2026-09-29T09:59:00.000Z',
	}) as SideEffectIntent

describe('newsletterOwnerBirthOf (row 204 guard)', () => {
	it('is the owner copy the live dispatch fans out: same key, same zone', () => {
		const completed = intent()
		const live = fanOutOwnedEvents(
			mapDrovrShadowFact({
				kind: 'side-effect-intent-completed',
				intent: completed,
			}),
			new Set(),
			new Set(['c1']),
		).filter(
			(event) =>
				event.tenantId === 'org-aihero' &&
				event.journeyId === 'shadow-newsletter',
		)
		expect(live).toHaveLength(1)
		const rebuilt = newsletterOwnerBirthOf(completed)
		expect(rebuilt).toEqual(live[0])
		expect(rebuilt).toMatchObject({
			type: 'contact.created',
			idempotencyKey:
				'owner:contact:org-aihero-shadow:c1:shadow-newsletter:birth',
			payload: { timezone: 'Asia/Tokyo', timezoneSource: 'vercel-header' },
		})
	})

	it('has no birth for another list', () => {
		expect(
			newsletterOwnerBirthOf(intent({ list: 'crash-course' })),
		).toBeUndefined()
	})
})

describe('isMysqlMissingTableError', () => {
	it('recognises 1146 anywhere in the cause chain', () => {
		expect(
			isMysqlMissingTableError(
				new Error('query failed', {
					cause: Object.assign(new Error('x'), { errno: 1146 }),
				}),
			),
		).toBe(true)
		expect(
			isMysqlMissingTableError(
				Object.assign(new Error('x'), { code: 'ER_NO_SUCH_TABLE' }),
			),
		).toBe(true)
		expect(
			isMysqlMissingTableError(
				new Error("Table 'ai-hero.AI_DrovrOutbox' doesn't exist"),
			),
		).toBe(true)
	})

	it('does not mistake other errors for a missing table', () => {
		expect(
			isMysqlMissingTableError(new Error('Vitess: connection reset')),
		).toBe(false)
		expect(
			isMysqlMissingTableError(
				Object.assign(new Error('dup'), { errno: 1062 }),
			),
		).toBe(false)
	})
})
