import { Cause, Effect, Option, Schema } from 'effect'

import type { AnyCapability } from '../contract.js'
import { failureStatus } from '../errors.js'
import { LearnerIdentity, LearnerRateLimit } from '../services.js'

export type EncodedFailure = {
	readonly _tag: string
	readonly message: string
	readonly next_actions?: ReadonlyArray<unknown>
} & Record<string, unknown>

/**
 * The outcome of one capability call, encoded for the wire. Every
 * projection (HTTP, MCP tools and prompts) goes through `invoke`, so input
 * decoding, the rate limit and output encoding happen exactly one way.
 * Encoding through the contract's output schema also drops any field the
 * schema does not name, so an adapter that over-returns cannot leak it.
 */
export type InvokeResult =
	| {
			readonly _tag: 'Success'
			readonly capability: string
			readonly output: Record<string, unknown>
	  }
	| {
			readonly _tag: 'Failure'
			readonly capability: string
			readonly status: number
			readonly error: EncodedFailure
	  }
	| {
			readonly _tag: 'InvalidInput'
			readonly capability: string
			readonly message: string
	  }
	| { readonly _tag: 'UnknownCapability'; readonly name: string }
	| {
			readonly _tag: 'Defect'
			readonly capability: string
			readonly cause: string
	  }

export const findCapability = (
	capabilities: ReadonlyArray<AnyCapability>,
	name: string,
) => capabilities.find((capability) => capability.contract.name === name)

export const invoke = <R>(
	capabilities: ReadonlyArray<AnyCapability>,
	name: string,
	rawInput: unknown,
): Effect.Effect<InvokeResult, never, R | LearnerIdentity | LearnerRateLimit> =>
	Effect.gen(function* () {
		const capability = findCapability(capabilities, name)
		if (!capability) return { _tag: 'UnknownCapability', name } as const
		const contract = capability.contract

		const decoded = yield* Schema.decodeUnknownEffect(contract.input)(
			rawInput ?? {},
			{
				errors: 'all',
			},
		).pipe(Effect.result)
		if (decoded._tag === 'Failure') {
			return {
				_tag: 'InvalidInput',
				capability: contract.name,
				message: decoded.failure.message,
			} as const
		}

		const identity = yield* LearnerIdentity
		const rateLimit = yield* LearnerRateLimit
		const limited = yield* rateLimit
			.consume({
				userId: Option.match(identity.current, {
					onNone: () => null,
					onSome: (learner) => learner.userId,
				}),
				capability: contract.name,
			})
			.pipe(Effect.result)
		if (limited._tag === 'Failure') {
			return {
				_tag: 'Failure',
				capability: contract.name,
				status: failureStatus.RateLimited ?? 429,
				error: {
					_tag: limited.failure._tag,
					message: limited.failure.message,
					retryAfterSeconds: limited.failure.retryAfterSeconds,
					next_actions: limited.failure.next_actions,
				},
			} as const
		}

		// SAFETY: the tuple erases each handler's requirements; they are `R`.
		const handler = capability.handler as (
			input: unknown,
		) => Effect.Effect<unknown, unknown, R>
		const isDeclared = Schema.is(contract.failure)
		const encodeOutput = Schema.encodeUnknownEffect(contract.output)
		const encodeFailure = Schema.encodeUnknownEffect(contract.failure)

		return yield* handler(decoded.success).pipe(
			Effect.flatMap((output) => encodeOutput(output)),
			Effect.map(
				(output): InvokeResult => ({
					_tag: 'Success',
					capability: contract.name,
					// SAFETY: every contract output is a Struct, which encodes to an object.
					output: output as Record<string, unknown>,
				}),
			),
			Effect.catch((failure) =>
				isDeclared(failure)
					? encodeFailure(failure).pipe(
							Effect.map((encoded): InvokeResult => {
								// SAFETY: every declared failure is a TaggedError with a message.
								const error = encoded as EncodedFailure
								return {
									_tag: 'Failure',
									capability: contract.name,
									status: failureStatus[error._tag] ?? 422,
									error,
								}
							}),
						)
					: Effect.die(failure),
			),
			Effect.catchCause((cause) =>
				Effect.succeed<InvokeResult>({
					_tag: 'Defect',
					capability: contract.name,
					cause: Cause.pretty(cause),
				}),
			),
		)
	})
