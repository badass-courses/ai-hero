import { pathToFileURL } from 'node:url'

import {
	CouponIssuePayload,
	EVERGREEN_OFFER_FIELD_KEYS,
	ISSUE_EVERGREEN_COUPON_INTENT_TYPE,
	offerFieldsFor,
} from '@/lib/subscriber-marketing/drovr-evergreen-coupon'

/**
 * DRY RUN ONLY: what rewriting the open coupons' deadline fields to the
 * absolute format would change. Same instant, new text. Reads coupon intents;
 * writes nothing to the database or to Kit. The rewrite itself waits for Joel's
 * copy approval and the deadline switch.
 *
 *   SKIP_ENV_VALIDATION=1 DOTENV_CONFIG_PATH=<checkout>/apps/ai-hero/.env.vercel \
 *     pnpm evergreen:deadline-fields:plan
 */

export type CouponIntentRow = {
	status: string
	metadata: Record<string, unknown>
}

export type DeadlineFieldsPlan = {
	open: number
	skipped: { expired: number; invalid: number }
	byZone: Record<string, number>
	samples: Array<{ zone: string; source: string; before: string; after: Record<string, string> }>
}

export function planDeadlineFieldRewrite(
	rows: readonly CouponIntentRow[],
	now: string,
	sampleSize = 3,
): DeadlineFieldsPlan {
	const plan: DeadlineFieldsPlan = {
		open: 0,
		skipped: { expired: 0, invalid: 0 },
		byZone: {},
		samples: [],
	}
	for (const row of rows) {
		const offer = CouponIssuePayload.safeParse(row.metadata.offer)
		const couponId = row.metadata.couponId
		if (row.status !== 'completed' || !offer.success || typeof couponId !== 'string') {
			plan.skipped.invalid += 1
			continue
		}
		if (Date.parse(offer.data.expiresAt) <= Date.parse(now)) {
			plan.skipped.expired += 1
			continue
		}
		const fields = (format: 'legacy' | 'absolute') =>
			offerFieldsFor({
				couponId,
				payload: offer.data,
				origin: 'https://www.aihero.dev',
				deadlineFormat: format,
			})
		plan.open += 1
		const zoneKey = `${offer.data.timezone} (${offer.data.timezoneSource})`
		plan.byZone[zoneKey] = (plan.byZone[zoneKey] ?? 0) + 1
		if (plan.samples.length < sampleSize) {
			const after = fields('absolute')
			plan.samples.push({
				zone: offer.data.timezone,
				source: offer.data.timezoneSource,
				before: fields('legacy')[EVERGREEN_OFFER_FIELD_KEYS.deadlineDisplay]!,
				after: {
					[EVERGREEN_OFFER_FIELD_KEYS.deadlineDisplay]:
						after[EVERGREEN_OFFER_FIELD_KEYS.deadlineDisplay]!,
					[EVERGREEN_OFFER_FIELD_KEYS.deadlineShort]:
						after[EVERGREEN_OFFER_FIELD_KEYS.deadlineShort]!,
				},
			})
		}
	}
	return plan
}

async function main() {
	const { db } = await import('@/db')
	const { sideEffectIntent } = await import('@/db/schema')
	const { and, eq } = await import('drizzle-orm')
	const rows = await db
		.select({ status: sideEffectIntent.status, metadata: sideEffectIntent.metadata })
		.from(sideEffectIntent)
		.where(
			and(
				eq(sideEffectIntent.type, ISSUE_EVERGREEN_COUPON_INTENT_TYPE),
				eq(sideEffectIntent.status, 'completed'),
			),
		)
	const plan = JSON.stringify(
		planDeadlineFieldRewrite(rows, new Date().toISOString()),
		null,
		2,
	)
	// The database pool keeps the process alive; exit once stdout has flushed,
	// so piped JSON is never truncated.
	process.stdout.write(`${plan}\n`, () => process.exit(0))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exit(2)
	})
}
