import { describe, expect, it } from 'vitest'

import {
	CHECKOUT_RECOVERY_APPLY_ENV,
	CHECKOUT_RECOVERY_REQUIRED_ENV,
	resolveCheckoutRecoveryEnv,
} from './checkout-recovery-runtime'

const dryRunSource = {
	DATABASE_URL: 'mysql://u:p@localhost:3306/db',
	STRIPE_SECRET_TOKEN: 'sk_test_placeholder',
}

const applySource = {
	...dryRunSource,
	INNGEST_EVENT_KEY: 'evt_key_placeholder',
	NEXT_PUBLIC_APP_NAME: 'ai-hero',
}

describe('checkout recovery environment boundary', () => {
	it('needs only the database url and the Stripe secret for a dry run', () => {
		expect(CHECKOUT_RECOVERY_REQUIRED_ENV).toEqual([
			'DATABASE_URL',
			'STRIPE_SECRET_TOKEN',
		])
		expect(resolveCheckoutRecoveryEnv(dryRunSource, { apply: false })).toEqual({
			databaseUrl: 'mysql://u:p@localhost:3306/db',
			stripeToken: 'sk_test_placeholder',
			stripeWebhookSecret: '',
			inngestAppId: null,
		})
	})

	it('ignores the unrelated Next app variables that blocked the old script', () => {
		const noisy = {
			...dryRunSource,
			OPENAI_API_KEY: undefined,
			MUX_SECRET_KEY: undefined,
			DEEPGRAM_API_KEY: undefined,
			CONVERTKIT_API_KEY: undefined,
			DROPBOX_SYNC_SHARED_LINK: undefined,
			COURSE_SYNC_STAGE_TOKEN: undefined,
			COURSE_SYNC_WORKER_TOKEN: undefined,
			COURSE_SYNC_OPERATOR_TOKEN: undefined,
		}
		expect(resolveCheckoutRecoveryEnv(noisy, { apply: false })).toEqual(
			resolveCheckoutRecoveryEnv(dryRunSource, { apply: false }),
		)
	})

	it('refuses the Vercel "[SENSITIVE]" placeholder by name without echoing values', () => {
		const source = {
			...dryRunSource,
			INNGEST_EVENT_KEY: '[SENSITIVE]',
			NEXT_PUBLIC_APP_NAME: 'ai-hero',
		}
		expect(() => resolveCheckoutRecoveryEnv(source, { apply: true })).toThrow(
			/placeholder, not a value: INNGEST_EVENT_KEY/,
		)
		expect(() => resolveCheckoutRecoveryEnv(source, { apply: true })).not.toThrow(
			/mysql:|sk_test/,
		)
	})

	it('treats the Stripe webhook secret as optional and passes it through', () => {
		expect(
			resolveCheckoutRecoveryEnv(
				{ ...dryRunSource, STRIPE_WEBHOOK_SECRET: 'whsec_placeholder' },
				{ apply: false },
			).stripeWebhookSecret,
		).toBe('whsec_placeholder')
	})

	it('demands the Inngest send variables only in apply mode', () => {
		expect(CHECKOUT_RECOVERY_APPLY_ENV).toEqual([
			'INNGEST_EVENT_KEY',
			'NEXT_PUBLIC_APP_NAME',
		])
		expect(() =>
			resolveCheckoutRecoveryEnv(dryRunSource, { apply: true }),
		).toThrow(
			'Missing required environment variables: INNGEST_EVENT_KEY, NEXT_PUBLIC_APP_NAME',
		)
		expect(
			resolveCheckoutRecoveryEnv(applySource, { apply: true }).inngestAppId,
		).toBe('ai-hero')
	})

	it('treats blank values as missing and never echoes a value', () => {
		let thrown: Error | undefined
		try {
			resolveCheckoutRecoveryEnv(
				{ DATABASE_URL: '   ', STRIPE_SECRET_TOKEN: 'sk_test_secret_value' },
				{ apply: false },
			)
		} catch (error) {
			thrown = error as Error
		}

		expect(thrown?.message).toBe(
			'Missing required environment variables: DATABASE_URL',
		)
		expect(thrown?.message).not.toContain('sk_test_secret_value')
	})
})
