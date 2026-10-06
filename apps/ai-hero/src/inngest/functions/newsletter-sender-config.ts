import { Data, Effect } from 'effect'

export const NEWSLETTER_LIMIT_CAP = 120
export const MIN_NEWSLETTER_PACING_MS = 2_000
export const MAX_NEWSLETTER_PACING_MS = 60_000
// Bound scheduled sleeps, leaving 200s under the route's 800s duration.
// Provider/DB latency and other lanes are not a proven total-runtime bound.
export const MAX_NEWSLETTER_BATCH_PACING_MS = 600_000

export class NewsletterSenderConfigError extends Data.TaggedError(
	'NewsletterSenderConfigError',
)<{ readonly message: string }> {}

export type NewsletterSenderConfig =
	| { readonly mode: 'legacy' }
	| { readonly mode: 'opt-in'; readonly limit: number; readonly pacingMs: number }

/** Either explicit input activates pacing AND provider-pause behavior.
 * BOTH undefined preserves the legacy path, without even evaluating inheritance.
 * Partial opt-in inherits the other input, including legacy zero pacing. */
export function parseNewsletterSenderConfig(input: {
	pacingMs: string | undefined
	limit: string | undefined
	inheritLimit: () => number
	inheritPacingMs: () => number
}): NewsletterSenderConfig {
	if (input.pacingMs === undefined && input.limit === undefined) {
		return { mode: 'legacy' }
	}
	const integer = (raw: string, control: string, min: number, max: number) => {
		const value = raw.trim()
		const parsed = Number(value)
		return /^(0|[1-9]\d*)$/.test(value) &&
			Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
			? Effect.succeed(parsed)
			: Effect.fail(new NewsletterSenderConfigError({
					message: `${control} must be an integer from ${min} to ${max}`,
				}))
	}
	const inherited = (read: () => number, control: string) => Effect.try({
		try: read,
		catch: () => new NewsletterSenderConfigError({ message: `${control}: inherited configuration is invalid` }),
	})
	const result = Effect.runSync(Effect.either(Effect.gen(function* () {
		// Validate ALL explicit inputs before evaluating inheritance or any HTTP.
		const explicitPacing = input.pacingMs === undefined ? undefined : yield* integer(
			input.pacingMs, 'AIH_DROVR_NEWSLETTER_PACING_MS', MIN_NEWSLETTER_PACING_MS, MAX_NEWSLETTER_PACING_MS,
		)
		const explicitLimit = input.limit === undefined ? undefined : yield* integer(
			input.limit, 'AIH_DROVR_NEWSLETTER_LIMIT', 1, NEWSLETTER_LIMIT_CAP,
		)
		const limit = explicitLimit ?? (yield* inherited(input.inheritLimit, 'AIH_DROVR_NEWSLETTER_LIMIT'))
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > NEWSLETTER_LIMIT_CAP) {
			return yield* Effect.fail(new NewsletterSenderConfigError({
				message: 'Set AIH_DROVR_NEWSLETTER_LIMIT explicitly from 1 to 120; inherited limit is outside the opt-in cap',
			}))
		}
		const pacingMs = explicitPacing ?? (yield* inherited(input.inheritPacingMs, 'AIH_DROVR_NEWSLETTER_PACING_MS'))
		if (!Number.isSafeInteger(pacingMs) || pacingMs < 0) {
			return yield* Effect.fail(new NewsletterSenderConfigError({ message: 'AIH_DROVR_NEWSLETTER_PACING_MS: inherited pacing is invalid' }))
		}
		if ((limit - 1) * pacingMs > MAX_NEWSLETTER_BATCH_PACING_MS) {
			return yield* Effect.fail(new NewsletterSenderConfigError({
				message: 'Newsletter batch pacing exceeds 600000ms; reduce AIH_DROVR_NEWSLETTER_LIMIT or AIH_DROVR_NEWSLETTER_PACING_MS',
			}))
		}
		return { mode: 'opt-in', limit, pacingMs } as const
	})))
	if (result._tag === 'Left') throw result.left
	return result.right
}
