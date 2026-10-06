import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { executePendingEvergreenSends } from '@/lib/subscriber-marketing/drovr-evergreen-sender'
import type { addSubscriberToKitSequence, updateKitSubscriberFields } from '@/lib/subscriber-marketing/drovr-evergreen'
import type { executePendingEvergreenCoupons } from '@/lib/subscriber-marketing/drovr-evergreen-coupon'

type SendArgs = Parameters<typeof executePendingEvergreenSends>[0]
type Handler = (input: { step: {
	run(id: string, work: () => Promise<unknown> | unknown): Promise<unknown>
	sendEvent(id: string, value: unknown): Promise<void>
} }) => Promise<unknown>
const control = vi.hoisted(() => {
	let handler: Handler | undefined
	const sends: SendArgs[] = []
	const posts: Parameters<typeof addSubscriberToKitSequence>[0][] = []
	const fields: Parameters<typeof updateKitSubscriberFields>[0][] = []
	const couponLimits: number[] = []
	const reads: string[] = []
	return { sends, posts, fields, couponLimits, reads, stopped: false,
		setHandler: (next: Handler) => { handler = next }, handler: () => handler }
})
vi.mock('@/inngest/inngest.server', () => ({ inngest: { createFunction: (_options: unknown, _trigger: unknown, handler: Handler) => { control.setHandler(handler); return handler } } }))
vi.mock('@/db', () => ({ db: {}, createDatabaseHandle: () => ({}) }))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({ DrizzleCaptureMarketingRepository: class { findNewsletterSendQueueCounts() { return { pending: 0, heldForExit: 0 } } } }))
vi.mock('@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority-mysql', () => ({ couponCommerceSchema: {}, createMySqlCouponCommerceStore: () => ({}) }))
vi.mock('@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority', () => ({ createCouponAuthority: () => ({}) }))
vi.mock('@/lib/subscriber-marketing/evergreen-merchant-evidence', () => ({ resolveEvergreenMerchantEvidence: async () => ({}) }))
vi.mock('@/lib/subscriber-marketing/drovr-contact-profile-sync-requests', () => ({ offerProfileSyncRequests: () => [], parseDrovrProfileSyncConfig: () => ({}) }))
vi.mock('@/lib/subscriber-marketing/drovr-evergreen', () => ({
	SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE: 'subscribe-evergreen-list',
	EVERGREEN_LIST_SEQUENCES: { 'shadow-newsletter': { backfillTagId: 'synthetic-tag' } },
	parseDrovrEvergreenConfig: () => ({ enabled: true }),
	readbackEvergreenListSequences: async () => { control.reads.push('lists'); return { ready: true } },
	readbackEvergreenSequences: async () => { control.reads.push('evergreen'); return { ready: true } },
	subscribeToEvergreenList: async () => 'added',
	addSubscriberToKitSequence: async (args: Parameters<typeof addSubscriberToKitSequence>[0]) => { control.posts.push(args); return 'added' },
	updateKitSubscriberFields: async (args: Parameters<typeof updateKitSubscriberFields>[0]) => { control.fields.push(args) },
}))
vi.mock('@/lib/subscriber-marketing/drovr-shadow-newsletter', () => ({
	SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE: 'send-shadow-newsletter-email',
	readbackShadowNewsletterSequences: async () => { control.reads.push('shadow'); return { ready: true } },
}))
vi.mock('@/lib/subscriber-marketing/drovr-evergreen-sender', () => ({
	executePendingEvergreenSends: async (args: SendArgs) => {
		control.sends.push(args)
		if (args.type === 'send-shadow-newsletter-email' && control.stopped) return [{ status: 'newsletter-paused', intentId: 'synthetic', reason: 'kit-429' }]
		await args.subscribe({ listId: 'synthetic-sequence', listType: 'sequence', user: { email: 'synthetic@aih.test.invalid' } })
		return []
	},
}))
vi.mock('@/lib/subscriber-marketing/drovr-evergreen-coupon', () => ({
	executePendingEvergreenCoupons: async (args: Parameters<typeof executePendingEvergreenCoupons>[0]) => {
		control.couponLimits.push(args.limit)
		await args.writeFields({ subscriberId: 'synthetic-id', email: 'synthetic@aih.test.invalid', fields: {} })
		return []
	},
}))
import './drovr-evergreen-sender'

const invoke = async (cache?: Map<string, unknown>) => {
	const handler = control.handler()
	if (!handler) throw new Error('No fake handler registered')
	return handler({ step: {
		run: async (id, work) => {
			if (cache?.has(id)) return cache.get(id)
			const value = await work(); cache?.set(id, value); return value
		}, sendEvent: async () => {},
	} })
}
const newsletter = () => control.sends.find(args => args.type === 'send-shadow-newsletter-email')

beforeEach(() => {
	control.sends.length = 0; control.posts.length = 0; control.fields.length = 0
	control.couponLimits.length = 0; control.reads.length = 0; control.stopped = false
	vi.stubEnv('AIH_DROVR_EVERGREEN_SENDER_LIMIT', '25')
	vi.stubEnv('AIH_DROVR_EVERGREEN_SENDER_PACING_MS', '3000')
})
afterEach(() => vi.unstubAllEnvs())

describe('combined cron, fake import closure: newsletter-only config/result injection', () => {
	it('both unset preserves inherited numbers, uncapped, no pause port or header mode', async () => {
		vi.stubEnv('AIH_DROVR_EVERGREEN_SENDER_LIMIT', '220')
		await invoke()
		expect(newsletter()).toMatchObject({ limit: 220, pacingMs: 3000 })
		expect(newsletter()).not.toHaveProperty('newsletter')
		expect(control.posts.every(post => !('newsletter429' in post))).toBe(true)
		expect(control.sends.map(args => [args.limit, args.pacingMs])).toEqual([[220, 3000], [220, 3000], [220, 3000]])
	})
	it.each(['pacing-only', 'limit-only', 'both'] as const)('activation %s is confined to newsletter; other providers/readbacks unchanged', async mode => {
		if (mode !== 'limit-only') vi.stubEnv('AIH_DROVR_NEWSLETTER_PACING_MS', '2000')
		if (mode !== 'pacing-only') vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', '120')
		if (mode === 'limit-only') vi.stubEnv('AIH_DROVR_EVERGREEN_SENDER_PACING_MS', '0')
		await invoke()
		expect(newsletter()).toMatchObject({ limit: mode === 'pacing-only' ? 25 : 120, pacingMs: mode === 'limit-only' ? 0 : 2000 })
		expect(newsletter()?.newsletter).toBeDefined()
		for (const args of control.sends.filter(args => args.type !== 'send-shadow-newsletter-email')) {
			expect(args.limit).toBe(25); expect(args.pacingMs).toBe(mode === 'limit-only' ? 0 : 3000); expect(args).not.toHaveProperty('newsletter')
		}
		expect(control.posts.map(post => post.newsletter429)).toEqual([true, undefined])
		expect(control.couponLimits).toEqual([25]); expect(control.fields).toHaveLength(1)
		expect(control.reads).toEqual(['lists', 'shadow', 'evergreen'])
	})
	it.each(['', 'bad', '121'])('invalid explicit LIMIT %j refuses before any fake provider/readback', async value => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', value)
		await expect(invoke()).rejects.toThrow('AIH_DROVR_NEWSLETTER_LIMIT')
		expect(control.reads).toEqual([]); expect(control.sends).toEqual([]); expect(control.posts).toEqual([])
	})
	it('pacing-only inherited limit>120 refuses before HTTP with an explicit LIMIT instruction', async () => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_PACING_MS', '2000'); vi.stubEnv('AIH_DROVR_EVERGREEN_SENDER_LIMIT', '220')
		await expect(invoke()).rejects.toThrow('Set AIH_DROVR_NEWSLETTER_LIMIT explicitly')
		expect(control.reads).toEqual([])
	})
	it('stopped newsletter result leaves later evergreen/coupon/readback calls intact', async () => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', '120'); control.stopped = true
		await invoke()
		expect(control.sends).toHaveLength(3); expect(control.couponLimits).toEqual([25])
		expect(control.reads).toEqual(['lists', 'shadow', 'evergreen']); expect(control.fields).toHaveLength(1)
		expect(control.posts).toHaveLength(1); expect(control.posts[0]).not.toHaveProperty('newsletter429')
	})
	it('a fake durable-step checkpoint preserves stopped result on replay, without reexecuting sends', async () => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', '120'); control.stopped = true
		const cache = new Map<string, unknown>()
		await invoke(cache); await invoke(cache)
		expect(control.sends).toHaveLength(3); expect(control.fields).toHaveLength(1)
		expect(control.reads).toEqual(['lists', 'shadow', 'evergreen'])
		// Software step model only. Hosted Inngest checkpoint/expiry behavior
		// remains an independent production verification boundary.
	})
})
