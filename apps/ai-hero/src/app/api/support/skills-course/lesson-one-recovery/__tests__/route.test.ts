import { createHmac } from 'node:crypto'

import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

import { buildSkillsCourseLessonOneEmail } from '@/lib/skills-course/lesson-one-email'
import type { SkillsLessonOneRecoveryDependencies } from '@/lib/skills-course/support-lesson-one-recovery'

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

import { createSkillsLessonOneRecoveryPostHandler } from '../route'

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
})
