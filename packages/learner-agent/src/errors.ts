import { Schema } from 'effect'

import { NextActions } from './next-actions.js'

/** The caller has no learner token. Public tools still work. */
export class SignInRequired extends Schema.TaggedError<SignInRequired>()(
	'SignInRequired',
	{ message: Schema.String, next_actions: NextActions },
) {}

/** Signed in, but this learner does not own the course or lesson. */
export class NotEntitled extends Schema.TaggedError<NotEntitled>()(
	'NotEntitled',
	{
		message: Schema.String,
		next_actions: NextActions,
	},
) {}

/**
 * The learner owns the workshop but it has not opened. Carries the title and
 * open date only, never lessons.
 */
export class NotYetOpen extends Schema.TaggedError<NotYetOpen>()('NotYetOpen', {
	message: Schema.String,
	title: Schema.String,
	opensAt: Schema.NullOr(Schema.String),
	next_actions: NextActions,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', {
	message: Schema.String,
	next_actions: NextActions,
}) {}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
	'RateLimited',
	{
		message: Schema.String,
		retryAfterSeconds: Schema.Finite,
		next_actions: NextActions,
	},
) {}

/** A dependency (database, search index) failed; retrying may work. */
export class Unavailable extends Schema.TaggedError<Unavailable>()(
	'Unavailable',
	{
		message: Schema.String,
		next_actions: NextActions,
	},
) {}

/**
 * The dispatcher's answer to input that does not decode, before any handler
 * runs. Not a capability failure, so it is in no contract's `failure`.
 */
export const InvalidInput = Schema.Struct({
	_tag: Schema.Literal('InvalidInput'),
	message: Schema.String,
}).annotate({ identifier: 'InvalidInput' })

/** HTTP status per failure tag, shared by the HTTP and OpenAPI projections. */
export const failureStatus: Readonly<Record<string, number>> = {
	SignInRequired: 401,
	NotEntitled: 403,
	NotYetOpen: 403,
	NotFound: 404,
	RateLimited: 429,
	Unavailable: 503,
}
