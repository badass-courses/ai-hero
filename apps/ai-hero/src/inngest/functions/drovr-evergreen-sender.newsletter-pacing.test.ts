import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { executePendingEvergreenSends } from '@/lib/subscriber-marketing/drovr-evergreen-sender'
import type { addSubscriberToKitSequence, updateKitSubscriberFields } from '@/lib/subscriber-marketing/drovr-evergreen'
import type { executePendingEvergreenCoupons } from '@/lib/subscriber-marketing/drovr-evergreen-coupon'
import { createNewsletterProviderPause } from './newsletter-provider-pause'

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
	const steps: string[] = []
	const events: { id: string; value: unknown }[] = []
	const failures: { storage?: 'read' | 'write'; unexpected?: boolean } = {}
	return { sends, posts, fields, couponLimits, reads, steps, events, failures,
		storageCalls: 0, profileSync: false, stopped: false,
		setHandler: (next: Handler) => { handler = next }, handler: () => handler }
})
vi.mock('@/inngest/inngest.server', () => ({ inngest: { createFunction: (_options: unknown, _trigger: unknown, handler: Handler) => { control.setHandler(handler); return handler } } }))
vi.mock('@/db', () => ({ db: {}, createDatabaseHandle: () => ({}) }))
vi.mock('@/lib/subscriber-marketing/drizzle-capture-repository', () => ({ DrizzleCaptureMarketingRepository: class { findNewsletterSendQueueCounts() { return { pending: 0, heldForExit: 0 } } } }))
vi.mock('@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority-mysql', () => ({ couponCommerceSchema: {}, createMySqlCouponCommerceStore: () => ({}) }))
vi.mock('@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority', () => ({ createCouponAuthority: () => ({}) }))
vi.mock('@/lib/subscriber-marketing/evergreen-merchant-evidence', () => ({ resolveEvergreenMerchantEvidence: async () => ({}) }))
vi.mock('@/lib/subscriber-marketing/drovr-contact-profile-sync-requests', () => ({ offerProfileSyncRequests: () => control.profileSync ? [{ name: 'synthetic-profile-sync', data: { synthetic: true } }] : [], parseDrovrProfileSyncConfig: () => ({}) }))
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
		if (args.type === 'send-shadow-newsletter-email') {
			if (control.failures.unexpected) throw new Error('synthetic sender failure')
			if (control.failures.storage) {
				// Real pause error mapping, fake storage only. Never invoke the
				// cron's lazy production Redis adapter or a global denying proxy.
				const pause = createNewsletterProviderPause({ store: { eval: async () => {
					control.storageCalls += 1
					throw new Error('synthetic private transport detail')
				} } })
				if (control.failures.storage === 'read') await pause.isPaused()
				else await pause.pause('120')
			}
		}
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
			control.steps.push(id)
			if (cache?.has(id)) return cache.get(id)
			const value = await work(); cache?.set(id, value); return value
		}, sendEvent: async (id, value) => { control.events.push({ id, value }) },
	} })
}
const newsletter = () => control.sends.find(args => args.type === 'send-shadow-newsletter-email')

beforeEach(() => {
	control.sends.length = 0; control.posts.length = 0; control.fields.length = 0
	control.couponLimits.length = 0; control.reads.length = 0; control.stopped = false
	control.steps.length = 0; control.events.length = 0; control.storageCalls = 0; control.profileSync = false
	delete control.failures.storage; delete control.failures.unexpected
	vi.stubEnv('AIH_DROVR_EVERGREEN_SENDER_LIMIT', '25')
	vi.stubEnv('AIH_DROVR_EVERGREEN_SENDER_PACING_MS', '3000')
})
afterEach(() => { vi.unstubAllEnvs() })

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
	it.each(['', 'bad', '121'])('invalid explicit LIMIT %j fails only the newsletter step', async value => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', value)
		expect(await invoke()).toMatchObject({ counts: { shadow: { 'newsletter-config-failed': 1 } } })
		expect(newsletter()).toBeUndefined()
		expect(control.reads).toEqual(['lists', 'shadow', 'evergreen'])
		expect(control.sends).toHaveLength(2); expect(control.couponLimits).toEqual([25]); expect(control.fields).toHaveLength(1)
		expect(control.posts).toHaveLength(1); expect(control.posts[0]).not.toHaveProperty('newsletter429')
	})
	it.each(['', 'bad', '1999', '60001'])('invalid PACING %j does not halt list/evergreen/coupons', async value => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_PACING_MS', value)
		expect(await invoke()).toMatchObject({ counts: { shadow: { 'newsletter-config-failed': 1 } } })
		expect(newsletter()).toBeUndefined(); expect(control.sends).toHaveLength(2)
		expect(control.reads).toEqual(['lists', 'shadow', 'evergreen']); expect(control.fields).toHaveLength(1)
	})
	it('pacing-only inherited limit>120 fails newsletter without changing other lane limits', async () => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_PACING_MS', '2000'); vi.stubEnv('AIH_DROVR_EVERGREEN_SENDER_LIMIT', '220')
		expect(await invoke()).toMatchObject({ counts: { shadow: { 'newsletter-config-failed': 1 } } })
		expect(newsletter()).toBeUndefined(); expect(control.sends.map(args => args.limit)).toEqual([220, 220])
		expect(control.reads).toEqual(['lists', 'shadow', 'evergreen']); expect(control.couponLimits).toEqual([220])
	})
	it('over-budget pacing refuses newsletter sends while the combined cron continues', async () => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', '120'); vi.stubEnv('AIH_DROVR_NEWSLETTER_PACING_MS', '10000')
		expect(await invoke()).toMatchObject({ counts: { shadow: { 'newsletter-config-failed': 1 } } })
		expect(newsletter()).toBeUndefined(); expect(control.sends).toHaveLength(2); expect(control.fields).toHaveLength(1)
	})
	it.each(['read', 'write'] as const)('thrown pause-store %s failure stays newsletter-only and permits profile sync', async operation => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', '120'); control.failures.storage = operation; control.profileSync = true
		expect(await invoke()).toMatchObject({ counts: { shadow: { 'newsletter-storage-failed': 1 } } })
		expect(control.storageCalls).toBe(1); expect(control.sends).toHaveLength(3)
		expect(control.reads).toEqual(['lists', 'shadow', 'evergreen'])
		expect(control.steps).toContain('count-newsletter-send-queue')
		expect(control.couponLimits).toEqual([25]); expect(control.fields).toHaveLength(1)
		expect(control.posts).toHaveLength(1); expect(control.posts[0]).not.toHaveProperty('newsletter429')
		expect(control.events).toEqual([{ id: 'request-offer-profile-syncs', value: [{ name: 'synthetic-profile-sync', data: { synthetic: true } }] }])
	})
	it('persists a caught storage failure in the step checkpoint without retrying the fake store', async () => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', '120'); control.failures.storage = 'read'
		const cache = new Map<string, unknown>()
		await invoke(cache); await invoke(cache)
		expect(cache.get('send-pending-shadow-newsletter-emails')).toEqual([{ status: 'newsletter-storage-failed' }])
		expect(control.storageCalls).toBe(1); expect(control.sends).toHaveLength(3); expect(control.fields).toHaveLength(1)
	})
	it('does not swallow unrelated thrown sender errors', async () => {
		vi.stubEnv('AIH_DROVR_NEWSLETTER_LIMIT', '120'); control.failures.unexpected = true
		await expect(invoke()).rejects.toThrow('synthetic sender failure')
		expect(control.storageCalls).toBe(0); expect(control.couponLimits).toEqual([])
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
