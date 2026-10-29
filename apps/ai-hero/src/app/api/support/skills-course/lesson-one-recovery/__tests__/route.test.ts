import { createHmac } from 'node:crypto'

import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

import { buildSkillsCourseLessonOneEmail } from '@/lib/skills-course/lesson-one-email'
import type { RecoveryStandingReader } from '@/lib/skills-course/recovery-standing'
import type { SkillsLessonOneRecoveryDependencies } from '@/lib/skills-course/support-lesson-one-recovery'
import type { ContactEventRecord } from '@/lib/subscriber-marketing/types'

// Kit is unreachable: the off-Kit standing must never ask it.
const kit = vi.hoisted(() => ({
	getSubscriberByEmail: vi.fn(async () => {
		throw new Error('Kit is unreachable')
	}),
}))
vi.mock('@/coursebuilder/email-list-provider', () => ({
	emailListProvider: { getSubscriberByEmail: kit.getSubscriberByEmail },
}))

vi.mock('@/env.mjs', () => ({
	env: {
		SUPPORT_WEBHOOK_SECRET: 'test-support-secret',
		POSTMARK_API_KEY: 'test-postmark-key',
		NEXT_PUBLIC_SITE_TITLE: 'AI Hero',
		NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.com',
		NEXT_PUBLIC_URL: 'https://www.aihero.dev',
	},
}))

vi.mock('@/server/logger', () => ({
	log: {
		info: vi.fn(async () => {}),
		warn: vi.fn(async () => {}),
		error: vi.fn(async () => {}),
		debug: vi.fn(async () => {}),
	},
	createRequestContext: () => ({ requestId: 'request_1' }),
	withLogContext: (_context: unknown, fn: () => unknown) => fn(),
	serializeError: (error: unknown) => ({ message: String(error) }),
}))

import {
	createLocalRecoverySubscribers,
	createSkillsLessonOneRecoveryPostHandler,
} from '../route'

const SECRET = 'test-support-secret'
const BODY = {
	operation: 'preview',
	identity: {
		email: 'learner@example.com',
		kitSubscriberId: 'kit_41',
	},
	recoveryId: 'skills-lesson-one-case-1',
	audit: {
		runId: 'support_run_1',
		conversationId: 'conversation_1',
		operatorId: 'operator_1',
		approvalReference: 'approved_by_operator',
		expectedInboundId: 'inbound_1',
	},
}

function request(body: unknown, options: { signed?: boolean } = {}) {
	const bodyText = JSON.stringify(body)
	const headers = new Headers({ 'content-type': 'application/json' })
	if (options.signed !== false) {
		const timestamp = Math.floor(Date.now() / 1000)
		const signature = createHmac('sha256', SECRET)
			.update(`${timestamp}.${bodyText}`)
			.digest('hex')
		headers.set(
			'x-support-signature',
			`timestamp=${timestamp},v1=${signature}`,
		)
	}
	return new NextRequest(
		'http://localhost/api/support/skills-course/lesson-one-recovery',
		{ method: 'POST', headers, body: bodyText },
	)
}

function dependencies(): SkillsLessonOneRecoveryDependencies {
	return {
		subscribers: {
			findByEmail: vi.fn(async () => ({
				state: 'found' as const,
				id: 'kit_41',
				email: 'learner@example.com',
				subscriberState: 'active',
			})),
		},
		store: {
			findContext: vi.fn(async () => ({
				contactId: 'contact_41',
				sourceIntentId: 'source_intent_1',
				sourceNextActionId: 'source_action_1',
				sourceKitSubscriberId: 'kit_41',
			})),
			findIntent: vi.fn(async () => null),
			createIntent: vi.fn(async () => {
				throw new Error('not expected')
			}),
			claimIntent: vi.fn(async () => {
				throw new Error('not expected')
			}),
			updateIntent: vi.fn(async () => {
				throw new Error('not expected')
			}),
		},
		email: {
			build: vi.fn(async () =>
				buildSkillsCourseLessonOneEmail({
					aih_value_path_answer_links_json: JSON.stringify([
						{
							optionValue: 'personal',
							href: 'https://example.com/personal',
						},
						{ optionValue: 'team', href: 'https://example.com/team' },
						{ optionValue: 'unsure', href: 'https://example.com/unsure' },
					]),
				}),
			),
		},
		provider: {
			findByRecoveryKey: vi.fn(async () => null),
			send: vi.fn(async () => {
				throw new Error('not expected')
			}),
			read: vi.fn(async () => null),
		},
		previewSecret: SECRET,
		now: () => new Date(),
		newClaimId: () => 'claim_1',
	}
}

describe('POST /api/support/skills-course/lesson-one-recovery', () => {
	it('rejects unsigned requests before identity lookup', async () => {
		const deps = dependencies()
		const handler = createSkillsLessonOneRecoveryPostHandler({
			webhookSecret: SECRET,
			dependencies: deps,
		})

		const response = await handler(request(BODY, { signed: false }))

		expect(response.status).toBe(401)
		expect(deps.subscribers.findByEmail).not.toHaveBeenCalled()
	})

	it('returns a preview token without writing or sending', async () => {
		const deps = dependencies()
		const handler = createSkillsLessonOneRecoveryPostHandler({
			webhookSecret: SECRET,
			dependencies: deps,
		})

		const response = await handler(request(BODY))
		const payload = await response.json()

		expect(response.status).toBe(200)
		expect(payload).toMatchObject({
			state: 'ready',
			operation: 'preview',
			intentState: 'not-created',
		})
		expect(deps.store.createIntent).not.toHaveBeenCalled()
		expect(deps.provider.send).not.toHaveBeenCalled()
	})

	it('rejects apply unless allowWrite is exactly true', async () => {
		const deps = dependencies()
		const handler = createSkillsLessonOneRecoveryPostHandler({
			webhookSecret: SECRET,
			dependencies: deps,
		})

		const response = await handler(
			request({
				...BODY,
				operation: 'apply',
				allowWrite: false,
				previewToken: 'not-used',
			}),
		)

		expect(response.status).toBe(400)
		expect(deps.store.createIntent).not.toHaveBeenCalled()
	})

	describe('off-Kit standing, Kit unreachable', () => {
		function standingReader(
			options: {
				stopped?: boolean
				drovrStops?: { reason: string }[]
				drovrDown?: boolean
				contact?: boolean
			} = {},
		): RecoveryStandingReader {
			const events = [
				{
					eventType: 'value-path.entered',
					occurredAt: '2026-09-01T10:00:00.000Z',
					providerReference: 'value-path:ai-hero-skills-workflow',
				},
				...(options.stopped
					? [
							{
								eventType: 'contact.unsubscribed',
								occurredAt: '2026-09-02T10:00:00.000Z',
							},
						]
					: []),
			] as ContactEventRecord[]
			return {
				findContactByEmail: async () =>
					options.contact === false
						? undefined
						: { id: 'contact_41', email: 'learner@example.com' },
				findKitSubscriberIds: async () => ['kit_41'],
				findContactEventsByType: async (_id, type) =>
					events.filter((entry) => entry.eventType === type),
				readDrovrStops: async () => {
					if (options.drovrDown) throw new Error('drovr 503')
					return options.drovrStops ?? []
				},
			}
		}

		function handlerWith(reader: RecoveryStandingReader) {
			const deps = {
				...dependencies(),
				subscribers: createLocalRecoverySubscribers(reader),
			}
			return {
				deps,
				handler: createSkillsLessonOneRecoveryPostHandler({
					webhookSecret: SECRET,
					dependencies: deps,
				}),
			}
		}

		it('subscribed: previews without asking Kit', async () => {
			const { handler } = handlerWith(standingReader())
			const response = await handler(request(BODY))
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({ state: 'ready' })
			expect(kit.getSubscriberByEmail).not.toHaveBeenCalled()
		})

		it('stopped: apply blocks before any intent or send', async () => {
			const { deps, handler } = handlerWith(standingReader({ stopped: true }))
			const response = await handler(
				request({
					...BODY,
					operation: 'apply',
					allowWrite: true,
					previewToken: `${Date.now() + 60_000}.sig`,
				}),
			)
			expect(response.status).toBe(409)
			expect(await response.json()).toEqual({
				state: 'blocked',
				reason: 'contact-stopped',
			})
			expect(deps.store.createIntent).not.toHaveBeenCalled()
			expect(deps.provider.send).not.toHaveBeenCalled()
			expect(kit.getSubscriberByEmail).not.toHaveBeenCalled()
		})

		it('stopped: a drovr stop blocks too', async () => {
			const { handler } = handlerWith(
				standingReader({ drovrStops: [{ reason: 'complained' }] }),
			)
			const response = await handler(request(BODY))
			expect(await response.json()).toEqual({
				state: 'blocked',
				reason: 'contact-stopped',
			})
		})

		it('unknown: drovr unreadable fails closed and says why', async () => {
			const { deps, handler } = handlerWith(standingReader({ drovrDown: true }))
			const response = await handler(request(BODY))
			expect(response.status).toBe(409)
			expect(await response.json()).toEqual({
				state: 'blocked',
				reason: 'stop-state-unknown',
			})
			expect(deps.store.findContext).not.toHaveBeenCalled()
		})

		it('not found: no directory contact', async () => {
			const { handler } = handlerWith(standingReader({ contact: false }))
			const response = await handler(request(BODY))
			expect(await response.json()).toEqual({
				state: 'blocked',
				reason: 'kit-subscriber-not-found',
			})
			expect(kit.getSubscriberByEmail).not.toHaveBeenCalled()
		})
	})
})
