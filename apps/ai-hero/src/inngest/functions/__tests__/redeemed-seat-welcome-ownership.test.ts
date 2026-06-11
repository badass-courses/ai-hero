import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const functionsDir = join(process.cwd(), 'src/inngest/functions')

describe('redeemed seat welcome ownership guardrails', () => {
	it('keeps generic post-purchase from sending redeemed-seat welcome emails', () => {
		const source = readFileSync(
			join(functionsDir, 'post-purchase-workflow.ts'),
			'utf8',
		)

		const skipGuard = source.indexOf('isFullPriceCouponRedemption)')
		const skipReason = source.indexOf('owned_by_team_seat_redemption_followup')
		const genericSend = source.indexOf(
			'request welcome email for ${context.resourceId}',
		)

		expect(skipGuard).toBeGreaterThan(-1)
		expect(skipReason).toBeGreaterThan(skipGuard)
		expect(genericSend).toBeGreaterThan(skipReason)
	})

	it('keeps Team Seat Redemption Followup idempotent per redeemed purchase', () => {
		const source = readFileSync(
			join(functionsDir, 'purchase-benefit-followup.ts'),
			'utf8',
		)

		const entitlementSource = readFileSync(
			join(process.cwd(), 'src/lib/purchase-benefit-entitlements.ts'),
			'utf8',
		)

		expect(source).toContain("idempotency: 'event.data.redeemedPurchaseId'")
		expect(source).toContain('sendTeamSeatRedemptionWelcomeEmail')
		expect(entitlementSource).toContain('teamSeatRedemptionWelcomeEmailSentAt')
	})
})
