import { Effect, Option } from 'effect'

import { SignInRequired } from '../errors.js'
import { nextHref, nextTool, type NextAction } from '../next-actions.js'
import type { Learner } from '../ports.js'
import { LearnerIdentity, LearnerSite } from '../services.js'

export const signInActions: Effect.Effect<NextAction[], never, LearnerSite> =
	LearnerSite.useSync((site) => [
		nextHref(
			site.connectUrl,
			'Ask the learner to sign in at aihero.dev and create an agent token, then send it as `Authorization: Bearer <token>`.',
		),
		nextHref(
			`${site.baseUrl}/oauth/device/code`,
			'Or sign in with the device flow: POST /oauth/device/code, have the learner open `verification_uri_complete`, then POST /oauth/token with `device_code` and `scope=learner:read`.',
		),
		nextTool(
			'search_course',
			'Search public AI Hero content without signing in.',
			{
				query: '<what to find>',
			},
		),
	])

/** The signed-in learner, or a `SignInRequired` failure that says how. */
export const requireLearner: Effect.Effect<
	Learner,
	SignInRequired,
	LearnerIdentity | LearnerSite
> = Effect.gen(function* () {
	const identity = yield* LearnerIdentity
	if (Option.isSome(identity.current)) return identity.current.value
	return yield* new SignInRequired({
		message: 'Sign in as the learner to use this tool.',
		next_actions: yield* signInActions,
	})
})

/**
 * Where the companion instructions live: the course page's markdown twin
 * when there is a course in hand, the full guide otherwise.
 */
export const instructionsAction = (
	courseUrl?: string,
): Effect.Effect<NextAction, never, LearnerSite> =>
	LearnerSite.useSync((site) =>
		nextHref(
			courseUrl ? `${courseUrl}.md` : site.instructionsUrl,
			'How to work this course as a study companion: follow the learner’s pace, use the session extract next to the video, never spoil solutions unless asked.',
		),
	)
