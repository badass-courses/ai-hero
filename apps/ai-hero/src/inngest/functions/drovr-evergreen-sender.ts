import { db } from '@/db'
import { inngest } from '@/inngest/inngest.server'
import { DrizzleCaptureMarketingRepository } from '@/lib/subscriber-marketing/drizzle-capture-repository'
import {
	addSubscriberToKitSequence,
	parseDrovrEvergreenConfig,
	readbackEvergreenSequences,
} from '@/lib/subscriber-marketing/drovr-evergreen'
import { executePendingEvergreenSends } from '@/lib/subscriber-marketing/drovr-evergreen-sender'
import { log } from '@/server/logger'

import { parseValuePathProviderPacingMs } from './value-path-provider-pacing'

/**
 * Sends the evergreen bridge and pitch messages drovr planned. Off until
 * AIH_DROVR_EVERGREEN_ENABLED, and even then every run re-proves that all
 * eight Kit sequences are active with one email before it touches a row:
 * the readback is the gate, not a deploy-time promise.
 */
const senderLimit = (raw: string | undefined): number => {
	const parsed = Number.parseInt(raw ?? '', 10)
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 25
}

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
			return { status: 'not-ready', problems: readback.problems }
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
				pacingMs: parseValuePathProviderPacingMs(
					process.env.AIH_VALUE_PATH_PROVIDER_PACING_MS,
				),
			}),
		)
		const counts = results.reduce<Record<string, number>>((acc, result) => {
			acc[result.status] = (acc[result.status] ?? 0) + 1
			return acc
		}, {})
		await log.info('drovr.evergreen.sender_run', { counts })
		return { status: 'ran', counts, results }
	},
)
