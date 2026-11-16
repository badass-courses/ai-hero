import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sendAnEmail: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	scheduleProductEvents: vi.fn(),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/subscriber-marketing/product-events-live', () => ({
	scheduleProductEvents: mocks.scheduleProductEvents,
}))
vi.mock('@/emails/basic-email', () => ({ default: () => null }))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@example.test' },
}))
vi.mock('@/server/logger', () => ({
	log: { info: mocks.info, error: mocks.error },
}))
vi.mock('@/server/redis-client', () => ({ redis: {} }))
vi.mock('@coursebuilder/utils/send-an-email', () => ({
	sendAnEmail: mocks.sendAnEmail,
}))
vi.mock('@upstash/ratelimit', () => ({
	Ratelimit: class {
		static slidingWindow() {
			return {}
		}
		async limit() {
			return { success: true, limit: 3, remaining: 2, reset: 0 }
		}
	},
}))

import { sendTeamInquiry } from './team-inquiry-actions'

const values = () => ({
	name: 'Test Person',
	email: 'team@example.test',
	companyName: 'Test Company',
	teamSize: '11-50' as const,
	message: 'Hello',
	website: '',
	timestamp: new Date(Date.now() - 5000).toISOString(),
})

beforeEach(() => {
	vi.clearAllMocks()
})

describe('team inquiry submission timing', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('returns an actionable error instead of success after an hour', async () => {
		const result = await sendTeamInquiry({
			...values(),
			country: 'Germany',
			trainingType: 'live',
			context: { source: 'training-partners', url: '/training-partners' },
			timestamp: new Date(Date.now() - 3600001).toISOString(),
		})

		expect(result).toEqual({
			error:
				'This form expired. Copy your answers before reloading the page, then send your inquiry again.',
		})
		expect(mocks.sendAnEmail).not.toHaveBeenCalled()
		expect(mocks.scheduleProductEvents).not.toHaveBeenCalled()
		expect(mocks.info).not.toHaveBeenCalled()
	})

	it('still silently drops submissions under three seconds', async () => {
		expect(
			await sendTeamInquiry({
				...values(),
				timestamp: new Date(Date.now() - 2999).toISOString(),
			}),
		).toEqual({ success: true })
		expect(mocks.sendAnEmail).not.toHaveBeenCalled()
		expect(mocks.scheduleProductEvents).not.toHaveBeenCalled()
		expect(mocks.info).toHaveBeenCalledOnce()
		expect(mocks.info).toHaveBeenCalledWith(
			'team_inquiry.spam.timing',
			expect.objectContaining({ timeDiff: 2999 }),
		)
	})

	it.each([5000, 3600001])(
		'still silently drops honeypot submissions aged %s ms',
		async (age) => {
			expect(
				await sendTeamInquiry({
					...values(),
					website: 'https://example.test',
					timestamp: new Date(Date.now() - age).toISOString(),
				}),
			).toEqual({ success: true })
			expect(mocks.sendAnEmail).not.toHaveBeenCalled()
			expect(mocks.scheduleProductEvents).not.toHaveBeenCalled()
			expect(mocks.info).toHaveBeenCalledOnce()
			expect(mocks.info).toHaveBeenCalledWith(
				'team_inquiry.spam.honeypot',
				expect.any(Object),
			)
		},
	)

	it.each([3000, 5000, 3600000])(
		'sends submissions aged %s ms, including both timing boundaries',
		async (age) => {
			expect(
				await sendTeamInquiry({
					...values(),
					timestamp: new Date(Date.now() - age).toISOString(),
				}),
			).toEqual({ success: true })
			expect(mocks.sendAnEmail).toHaveBeenCalledOnce()
			expect(mocks.scheduleProductEvents).toHaveBeenCalledOnce()
			expect(mocks.info).toHaveBeenCalledWith(
				'team_inquiry.submitted',
				expect.any(Object),
			)
		},
	)
})

describe('team inquiry email', () => {
	it.each(['live', 'self-paced'] as const)(
		'includes partner subject and %s routing fields',
		async (trainingType) => {
			expect(
				await sendTeamInquiry({
					...values(),
					country: 'Switzerland',
					trainingType,
					context: { source: 'training-partners', url: '/training-partners' },
				}),
			).toEqual({ success: true })
			expect(mocks.sendAnEmail).toHaveBeenCalledWith(
				expect.objectContaining({
					Subject:
						'Training partners inquiry from Test Company (11-50 employees)',
					ReplyTo: 'team@example.test',
					componentProps: expect.objectContaining({
						body: expect.stringContaining('Country: Switzerland'),
					}),
				}),
			)
			expect(mocks.sendAnEmail.mock.calls[0]![0].componentProps.body).toContain(
				`Training type: ${trainingType}`,
			)
			expect(mocks.info).toHaveBeenCalledWith(
				'team_inquiry.submitted',
				expect.objectContaining({
					country: 'Switzerland',
					trainingType,
					email: 'team@example.test',
				}),
			)
			expect(mocks.scheduleProductEvents).toHaveBeenCalledWith(
				expect.any(Function),
				[
					expect.objectContaining({
						_tag: 'TeamIntent',
						intent: 'seats',
						sourceId: 'team-inquiry',
					}),
				],
			)
		},
	)

	it.each([undefined, 'workshop'])(
		'keeps the old subject and optional fields for source %s',
		async (source) => {
			expect(
				await sendTeamInquiry({
					...values(),
					context: { source, url: '/for-your-team' },
				}),
			).toEqual({ success: true })
			const email = mocks.sendAnEmail.mock.calls[0]![0]
			expect(email.Subject).toBe(
				'Team Inquiry from Test Company (11-50 employees)',
			)
			expect(email.componentProps.body).not.toContain('Country:')
			expect(email.componentProps.body).not.toContain('Training type:')
		},
	)

	it.each([undefined, 'workshop'])(
		'omits unvalidated partner fields from other sources: %s',
		async (source) => {
			expect(
				await sendTeamInquiry({
					...values(),
					country: '<script>unsafe</script>',
					// Model an untrusted server-action payload, not a typed form value.
					trainingType: '<b>x</b>' as unknown as 'live',
					context: { source, url: '/for-your-team' },
				}),
			).toEqual({ success: true })
			const body = mocks.sendAnEmail.mock.calls[0]![0].componentProps.body
			expect(body).not.toContain('Country:')
			expect(body).not.toContain('Training type:')
			expect(body).not.toContain('<b>x</b>')
			expect(body).not.toContain('<script>')
		},
	)

	it('sanitizes the validated partner country before building the email', async () => {
		expect(
			await sendTeamInquiry({
				...values(),
				country: 'Germany<script>unsafe</script>',
				trainingType: 'live',
				context: { source: 'training-partners', url: '/training-partners' },
			}),
		).toEqual({ success: true })
		const body = mocks.sendAnEmail.mock.calls[0]![0].componentProps.body
		expect(body).toContain('Country: Germany')
		expect(body).toContain('Training type: live')
		expect(body).not.toContain('<script>')
		expect(body).not.toContain('unsafe')
	})

	it.each([
		{},
		{ country: 'Germany' },
		{ trainingType: 'live' as const },
		{ country: '   ', trainingType: 'live' as const },
	])(
		'rejects incomplete partner requests on the server: %j',
		async (fields) => {
			const result = await sendTeamInquiry({
				...values(),
				...fields,
				context: { source: 'training-partners', url: '/training-partners' },
			})
			expect(result.error).toBeTruthy()
			expect(mocks.sendAnEmail).not.toHaveBeenCalled()
			expect(mocks.scheduleProductEvents).not.toHaveBeenCalled()
		},
	)
})
