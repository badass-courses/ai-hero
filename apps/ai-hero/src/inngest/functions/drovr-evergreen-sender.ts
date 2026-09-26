import { couponCommerceSchema } from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority-mysql'
import { createDatabaseHandle, db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	addSubscriberToKitSequence,
	EVERGREEN_LIST_SEQUENCES,
	parseDrovrEvergreenConfig,
	readbackEvergreenListSequences,
	readbackEvergreenSequences,
	SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE,
	subscribeToEvergreenList,
	updateKitSubscriberFields,
} from '@/lib/subscriber-marketing/drovr-evergreen'
import { executePendingEvergreenCoupons } from '@/lib/subscriber-marketing/drovr-evergreen-coupon'
import { createCouponAuthority } from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority'
import { createMySqlCouponCommerceStore } from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority-mysql'
import { resolveEvergreenMerchantEvidence } from '@/lib/subscriber-marketing/evergreen-merchant-evidence'
import { executePendingEvergreenSends } from '@/lib/subscriber-marketing/drovr-evergreen-sender'
import {
	readbackShadowNewsletterSequences,
	SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE,
} from '@/lib/subscriber-marketing/drovr-shadow-newsletter'
import { log } from '@/server/logger'

import { evergreenSenderPacingMs } from './evergreen-sender-pacing'

/**
 * Sends drovr's evergreen and shadow-newsletter sequence enrollments. Off
 * until AIH_DROVR_EVERGREEN_ENABLED, and every customer-visible sequence
 * write is behind a live Kit readback gate rather than a deploy-time promise.
 */
const senderLimit = (raw: string | undefined): number => {
	const parsed = Number.parseInt(raw ?? '', 10)
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 25
}

const tally = (rows: readonly { status: string }[]) =>
	rows.reduce<Record<string, number>>((acc, result) => {
		acc[result.status] = (acc[result.status] ?? 0) + 1
		return acc
	}, {})

export const drovrEvergreenSender = inngest.createFunction(
	{
		id: 'drovr-evergreen-sender-v1',
		name: 'drovr: send evergreen bridge and pitch messages',
		retries: 1,
		concurrency: 1,
	},
	{ cron: '*/5 * * * *' },
	async ({ step }) => {
		const config = parseDrovrEvergreenConfig(process.env)
		if (!config.enabled) {
			return { status: 'off', reason: config.reason }
		}
		// The list handoff has its own gate and runs first: the newsletter
		// sequence must be active and non-repeating (a re-add to a repeating
		// sequence would replay the newsletter; a held one falls back to the
		// backfill tag like the entry path), and a
		// problem with the eight bridge/pitch sequences must not hold a journey
		// that is only waiting to close on its handoff.
		const listReadback = await step.run('readback-kit-list-sequences', () =>
			readbackEvergreenListSequences({
				apiKey: process.env.KIT_V4_API_KEY,
				fetch,
			}),
		)
		const lists = listReadback.ready
			? await step.run('subscribe-pending-evergreen-lists', () =>
					executePendingEvergreenSends({
						repository: new DrizzleCaptureMarketingRepository(db),
						type: SUBSCRIBE_EVERGREEN_LIST_INTENT_TYPE,
						subscribe: (input) =>
							subscribeToEvergreenList({
								apiKey: process.env.KIT_V4_API_KEY,
								fetch,
								sequenceId: input.listId,
								backfillTagId:
									EVERGREEN_LIST_SEQUENCES['shadow-newsletter'].backfillTagId,
								email: input.user.email,
							}),
						limit: senderLimit(process.env.AIH_DROVR_EVERGREEN_SENDER_LIMIT),
						pacingMs: evergreenSenderPacingMs(process.env),
					}),
				)
			: []
		if (!listReadback.ready) {
			await log.warn('drovr.evergreen.lists_not_ready', {
				problems: listReadback.problems,
			})
		}
		const shadowReadback = await step.run(
			'readback-kit-shadow-newsletter-sequences',
			() =>
				readbackShadowNewsletterSequences({
					apiKey: process.env.KIT_V4_API_KEY,
					fetch,
				}),
		)
		const shadowSends = shadowReadback.ready
			? await step.run('send-pending-shadow-newsletter-emails', () =>
					executePendingEvergreenSends({
						repository: new DrizzleCaptureMarketingRepository(db),
						type: SEND_SHADOW_NEWSLETTER_EMAIL_INTENT_TYPE,
						subscribe: (input) =>
							addSubscriberToKitSequence({
								apiKey: process.env.KIT_V4_API_KEY,
								fetch,
								sequenceId: input.listId,
								email: input.user.email,
							}),
						limit: senderLimit(
							process.env.AIH_DROVR_EVERGREEN_SENDER_LIMIT,
						),
						pacingMs: evergreenSenderPacingMs(process.env),
					}),
				)
			: []
		if (!shadowReadback.ready) {
			await log.warn('drovr.shadow_newsletter.not_ready', {
				problems: shadowReadback.problems,
			})
		}
		const readback = await step.run('readback-kit-sequences', () =>
			readbackEvergreenSequences({
				apiKey: process.env.KIT_V4_API_KEY,
				fetch,
			}),
		)
		if (!readback.ready) {
			await log.warn('drovr.evergreen.not_ready', {
				problems: readback.problems,
			})
			return {
				status: 'not-ready',
				problems: readback.problems,
				counts: { lists: tally(lists), shadow: tally(shadowSends) },
			}
		}
		const results = await step.run('send-pending-evergreen-emails', () =>
			executePendingEvergreenSends({
				repository: new DrizzleCaptureMarketingRepository(db),
				// Same v4 key as the readback: the gate and the write prove the
				// same account, and the sequence ids are that account's.
				subscribe: (input) =>
					addSubscriberToKitSequence({
						apiKey: process.env.KIT_V4_API_KEY,
						fetch,
						sequenceId: input.listId,
						email: input.user.email,
					}),
				limit: senderLimit(process.env.AIH_DROVR_EVERGREEN_SENDER_LIMIT),
				pacingMs: evergreenSenderPacingMs(process.env),
			}),
		)
		const coupons = await step.run(
			'issue-pending-evergreen-coupons',
			async () => {
				const evidence = await resolveEvergreenMerchantEvidence()
				return executePendingEvergreenCoupons({
					repository: new DrizzleCaptureMarketingRepository(db),
					authority: createCouponAuthority({
						store: createMySqlCouponCommerceStore(
							createDatabaseHandle(couponCommerceSchema),
						),
						merchantCouponEvidence: evidence,
						now: () => new Date().toISOString(),
					}),
					writeFields: ({ subscriberId, email, fields }) =>
						updateKitSubscriberFields({
							apiKey: process.env.KIT_V4_API_KEY,
							fetch,
							subscriberId,
							email,
							fields,
						}),
					origin: 'https://www.aihero.dev',
					limit: senderLimit(process.env.AIH_DROVR_EVERGREEN_SENDER_LIMIT),
				})
			},
		)
		const counts = {
			coupons: tally(coupons),
			sends: tally(results),
			lists: tally(lists),
			shadow: tally(shadowSends),
		}
		await log.info('drovr.evergreen.sender_run', counts)
		return { status: 'ran', counts, results, coupons, lists, shadowSends }
	},
)
