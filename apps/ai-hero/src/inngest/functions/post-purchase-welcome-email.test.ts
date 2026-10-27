import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
	details: vi.fn(),
	send: vi.fn(),
	info: vi.fn(),
}))
vi.mock('@/config', () => ({ default: { defaultTitle: 'AI Hero' } }))
vi.mock('@/lib/cohort-welcome-details-query', () => ({
	getCohortWelcomeDetails: mocks.details,
}))
vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_SUPPORT_EMAIL: 'support@aihero.dev' },
}))
vi.mock('@/server/logger', () => ({ log: { info: mocks.info } }))
vi.mock('@coursebuilder/utils/send-an-email', () => ({
	sendAnEmail: mocks.send,
}))
vi.mock('@coursebuilder/core/schemas', () => ({
	ContentResourceSchema: { parse: (resource: unknown) => resource },
}))
vi.mock('../inngest.server', () => ({
	inngest: {
		createFunction: (config: unknown, trigger: unknown, handler: unknown) => ({
			config,
			trigger,
			handler,
		}),
	},
}))
import { postPurchaseWelcomeEmail } from './post-purchase-welcome-email'
const fn = postPurchaseWelcomeEmail as unknown as {
	handler: (input: any) => Promise<unknown>
}
const run = async (resourceId: string, productType = 'cohort') =>
	fn.handler({
		event: {
			data: {
				purchaseId: 'purchase-fixture',
				userId: 'user-fixture',
				userEmail: 'learner@example.com',
				resourceId,
				resourceProductType: productType,
				resourceData: {
					id: resourceId,
					type: 'cohort',
					fields: { title: 'Queued title', slug: 'queued-slug' },
				},
				workshopAvailability: {
					availableNow: [{ title: 'Stale draft', slug: 'draft' }],
					upcoming: [],
				},
			},
		},
		step: { run: (_name: string, work: () => unknown) => work() },
	})
beforeEach(() => {
	vi.resetAllMocks()
})
describe('individual welcome send contract', () => {
	it('uses send-time details rather than displaying queued workshop summaries', async () => {
		const details = {
			title: 'AI Coding for Real Engineers',
			schedule: 'Current dates',
			workshops: [],
		}
		mocks.details.mockResolvedValue(details)
		await run('cohort-xdy1m')
		expect(mocks.details).toHaveBeenCalledWith('cohort-xdy1m', 'user-fixture')
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				Subject: 'Welcome to AI Coding for Real Engineers',
				To: 'learner@example.com',
				ReplyTo: 'support@aihero.dev',
				From: 'support@aihero.dev',
				type: 'transactional',
				componentProps: expect.objectContaining({ welcomeDetails: details }),
			}),
		)
	})
	it('keeps the other cohort subject and legacy props unchanged', async () => {
		await run('cohort-other')
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({
				Subject: 'Welcome to Queued title!',
				To: 'learner@example.com',
				componentProps: expect.objectContaining({
					availableNow: [{ title: 'Stale draft', slug: 'draft' }],
					welcomeDetails: undefined,
				}),
			}),
		)
	})
	it('does not load cohort details for a workshop purchase', async () => {
		await run('workshop-other', 'self-paced')
		expect(mocks.details).not.toHaveBeenCalled()
		expect(mocks.send).toHaveBeenCalledWith(
			expect.objectContaining({ Subject: 'Welcome to Queued title!' }),
		)
	})
})
