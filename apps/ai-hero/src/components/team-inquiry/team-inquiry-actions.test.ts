import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	sendAnEmail: vi.fn(),
	info: vi.fn(),
	error: vi.fn(),
	scheduleProductEvents: vi.fn(),
	allowed: true,
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
			return { success: mocks.allowed, limit: 3, remaining: 2, reset: 0 }
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
const live = {
	country: 'CH',
	trainingType: 'live',
	engineersToTrain: '10-25',
	format: 'Remote',
	topics: ['Other'],
	timing: 'This month',
} as const
const context = { source: 'training-partners', url: '/training-partners' }
const fields = () => ({ ...live, topics: [...live.topics] })

beforeEach(() => {
	vi.clearAllMocks()
	mocks.allowed = true
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
		'includes %s routing fields and preserves delivery and log contracts',
		async (trainingType) => {
			expect(
				await sendTeamInquiry({
					...values(),
					...fields(),
					trainingType,
					context,
				}),
			).toEqual({ success: true })
			expect(mocks.sendAnEmail).toHaveBeenCalledWith(
				expect.objectContaining({
					Subject: `Training request: Test Company, CH, route ${trainingType === 'live' ? 'inovex (3.2)' : 'team-sales (self-paced)'}`,
					To: 'support@example.test',
					ReplyTo: 'team@example.test',
					type: 'transactional',
				}),
			)
			const body = mocks.sendAnEmail.mock.calls[0]![0].componentProps.body
			for (const label of [
				'Country: CH',
				`Training type: ${trainingType}`,
				'Training location: same',
				'Training country: CH',
				'Engineers to train:',
				'Format:',
				'Topics:',
				'Timing:',
				'Partner preference: No preference',
				'Suggested route:',
			])
				expect(body).toContain(label)
			expect(body).toContain(
				trainingType === 'live'
					? 'Engineers to train: 10-25'
					: 'Engineers to train: Not applicable',
			)
			expect(mocks.info).toHaveBeenCalledWith(
				'team_inquiry.submitted',
				expect.objectContaining({
					country: 'CH',
					trainingType,
					email: 'team@example.test',
					suggestedRoute: trainingType === 'live' ? 'inovex' : 'team-sales',
					topics: trainingType === 'live' ? ['Other'] : undefined,
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
	it.each([undefined, 'workshop', 'for-teams-page'])(
		'keeps other sources unchanged: %s',
		async (source) => {
			expect(
				await sendTeamInquiry({
					...values(),
					country: '<script>unsafe</script>',
					trainingType: '<b>x</b>' as 'live',
					context: { source, url: '/for-your-team' },
				}),
			).toEqual({ success: true })
			const email = mocks.sendAnEmail.mock.calls[0]![0]
			expect(email.Subject).toBe(
				'Team Inquiry from Test Company (11-50 employees)',
			)
			for (const field of [
				'Country:',
				'Training type:',
				'Suggested route:',
				'<b>x</b>',
				'<script>',
			])
				expect(email.componentProps.body).not.toContain(field)
		},
	)
	it('sanitizes the named partner and subject, and records an alternate training country', async () => {
		expect(
			await sendTeamInquiry({
				...values(),
				...fields(),
				country: 'US',
				trainingLocation: 'elsewhere',
				trainingCountry: 'GB',
				partnerPreference: 'specific',
				specificPartner: '<b>Partner</b><script>unsafe</script>',
				companyName: '<b>Company</b>\r\n',
				context,
			}),
		).toEqual({ success: true })
		const email = mocks.sendAnEmail.mock.calls[0]![0]
		expect(email.Subject).toBe(
			'Training request: Company  , US, route review (4.4-client-preference)',
		)
		expect(email.componentProps.body).toContain('Partner preference: Partner')
		expect(email.componentProps.body).toContain('Training country: GB')
		expect(email.componentProps.body).not.toContain('unsafe')
		expect(email.componentProps.body).not.toContain('<b>Partner</b>')
	})
	it.each([
		{},
		{ country: 'Germany' },
		{ trainingType: 'live' as const },
		{ ...fields(), country: 'ZZ' },
		{ ...fields(), topics: [] },
		{ ...fields(), trainingLocation: 'elsewhere' as const },
	])('rejects incomplete or invalid partner requests: %j', async (data) => {
		expect(
			(await sendTeamInquiry({ ...values(), ...data, context })).error,
		).toBeTruthy()
		expect(mocks.sendAnEmail).not.toHaveBeenCalled()
		expect(mocks.scheduleProductEvents).not.toHaveBeenCalled()
	})
	it.each(['honeypot', 'fast', 'expired', 'rate-limit'])(
		'preserves spam guard: %s',
		async (guard) => {
			mocks.allowed = guard !== 'rate-limit'
			expect(
				await sendTeamInquiry({
					...values(),
					...fields(),
					context,
					...(guard === 'honeypot' ? { website: 'bot' } : {}),
					...(guard === 'fast' ? { timestamp: new Date().toISOString() } : {}),
					...(guard === 'expired'
						? { timestamp: new Date(Date.now() - 3601000).toISOString() }
						: {}),
				}),
			).toEqual({ success: true })
			expect(mocks.sendAnEmail).not.toHaveBeenCalled()
		},
	)
})
