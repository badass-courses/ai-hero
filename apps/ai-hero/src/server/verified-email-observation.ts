import { AsyncLocalStorage } from 'node:async_hooks'
import { isDeepStrictEqual } from 'node:util'
import type { AuthConfig } from '@auth/core'
import type { Adapter } from '@auth/core/adapters'
import { z } from 'zod'
import {
	isStoredEmail,
	normalizeEmail,
} from '@/lib/subscriber-marketing/contact-email-equivalence'

/** Private request memory only. Never serialize/log this input; the writer
 * converts it to the accepted domain-separated fingerprints before storage. */
export type EmailLoginCapture = Readonly<{
	userId: string
	email: string
	verifiedAt: string
	acceptedToken: string
	sessionToken: string
	sessionExpires: string
}>
export type EmailObservationResult = {
	readonly type: 'Recorded' | 'Conflict' | 'Unavailable'
}
type SignIn = NonNullable<NonNullable<AuthConfig['events']>['signIn']>
const id = z.string().min(1).max(255)
const email = z
	.string()
	.max(510)
	.refine(isStoredEmail)
	.transform(normalizeEmail)
const token = z.object({
	identifier: email,
	token: z.string().min(1).max(2048),
	expires: z.date(),
})
const user = z.object({ id, email, emailVerified: z.date() })
const session = z.object({
	userId: id,
	sessionToken: z.string().min(1).max(2048),
	expires: z.date(),
})
type Evidence = {
	token?: z.infer<typeof token>
	user?: z.infer<typeof user>
	session?: z.infer<typeof session>
}
type RequestState =
	| { type: 'collecting'; evidence: Evidence }
	| { type: 'invalid' }
	| { type: 'observed' }
type RequestScope = { state: RequestState }
export type EmailObservationOptions =
	| { readonly enabled: false }
	| {
			readonly enabled: true
			readonly providerId: string
			readonly now: () => Date
			readonly writer: (
				capture: EmailLoginCapture,
			) => Promise<EmailObservationResult>
			readonly diagnostic?: (
				code:
					| 'capture-invalid'
					| 'observation-recorded'
					| 'observation-conflict'
					| 'observation-unavailable',
			) => unknown
	  }
export function createVerifiedEmailObservation(
	options: EmailObservationOptions,
) {
	const scopes = new AsyncLocalStorage<RequestScope>()
	function run<T>(request: Request, operation: () => T): T {
		if (!options.enabled) return operation()
		// Route admission only; request/query values never supply proof.
		let callback = false
		try {
			callback = new URL(request.url).pathname.endsWith(
				`/callback/${encodeURIComponent(options.providerId)}`,
			)
		} catch {}
		return callback
			? scopes.run({ state: { type: 'collecting', evidence: {} } }, operation)
			: operation()
	}
	function safely<A>(capture: () => A): A | undefined {
		if (!options.enabled) return undefined
		const scope = scopes.getStore()
		if (!scope || scope.state.type !== 'collecting') return undefined
		try {
			return capture()
		} catch {
			scope.state = { type: 'invalid' }
			return undefined
		}
	}
	function keep<K extends keyof Evidence>(
		key: K,
		value: NonNullable<Evidence[K]>,
	) {
		safely(() => {
			const scope = scopes.getStore()!
			if (scope.state.type !== 'collecting') return
			const prior = scope.state.evidence[key]
			if (
				prior === undefined &&
				((key === 'user' && !scope.state.evidence.token) ||
					(key === 'session' && !scope.state.evidence.user))
			) {
				scope.state = { type: 'invalid' }
				return
			}
			if (prior !== undefined && !isDeepStrictEqual(prior, value)) {
				scope.state = { type: 'invalid' }
				return
			}
			scope.state.evidence[key] = structuredClone(value)
		})
	}
	function wrapAdapter<T extends Adapter>(adapter: T): T {
		if (!options.enabled) return adapter
		const wrapped = { ...adapter }
		// The contained adapter owns its receiver, including non-observed methods.
		for (const key of Object.keys(adapter) as (keyof T)[]) {
			const method = adapter[key]
			if (typeof method === 'function') wrapped[key] = method.bind(adapter)
		}
		if (adapter.useVerificationToken) {
			const original = adapter.useVerificationToken.bind(adapter)
			wrapped.useVerificationToken = async (input) => {
				const requested = safely(() => structuredClone(input))
				const result = await original(input) // Original adapter failures propagate.
				safely(() => {
					const accepted = token.parse(result)
					if (
						!requested ||
						requested.token !== accepted.token ||
						(requested.identifier !== undefined &&
							email.parse(requested.identifier) !== accepted.identifier)
					)
						throw new Error('Token mismatch')
					keep('token', accepted)
				})
				return result
			}
		}
		if (adapter.createUser) {
			const original = adapter.createUser.bind(adapter)
			wrapped.createUser = async (input) => {
				const requested = safely(() => ({
					email: email.parse(input.email),
					verifiedAt: z.date().parse(input.emailVerified).toISOString(),
				}))
				const result = await original(input)
				safely(() => {
					const returned = user.parse(result)
					if (
						!requested ||
						returned.email !== requested.email ||
						returned.emailVerified.toISOString() !== requested.verifiedAt
					)
						throw new Error('Verification mismatch')
					keep('user', returned)
				})
				return result
			}
		}
		if (adapter.updateUser) {
			const original = adapter.updateUser.bind(adapter)
			wrapped.updateUser = async (input) => {
				const requested = safely(() => ({
					id: id.parse(input.id),
					email:
						input.email === undefined ? undefined : email.parse(input.email),
					verifiedAt: z.date().parse(input.emailVerified).toISOString(),
				}))
				const result = await original(input)
				safely(() => {
					const returned = user.parse(result)
					if (
						!requested ||
						returned.id !== requested.id ||
						(requested.email !== undefined &&
							returned.email !== requested.email) ||
						returned.emailVerified.toISOString() !== requested.verifiedAt
					)
						throw new Error('Verification mismatch')
					keep('user', returned)
				})
				return result
			}
		}
		if (adapter.createSession) {
			const original = adapter.createSession.bind(adapter)
			wrapped.createSession = async (input) => {
				const requested = safely(() => ({
					userId: input.userId,
					sessionToken: input.sessionToken,
				}))
				const result = await original(input)
				safely(() => {
					const returned = session.parse(result)
					if (
						!requested ||
						returned.userId !== requested.userId ||
						returned.sessionToken !== requested.sessionToken
					)
						throw new Error('Session mismatch')
					keep('session', returned)
				})
				return result
			}
		}
		return wrapped
	}
	async function diagnose(
		code: Parameters<
			NonNullable<
				Extract<EmailObservationOptions, { enabled: true }>['diagnostic']
			>
		>[0],
	) {
		if (!options.enabled) return
		try {
			await options.diagnostic?.(code)
		} catch {
			/* Diagnostics cannot break auth. */
		}
	}
	async function observe(input: Parameters<SignIn>[0]) {
		if (!options.enabled) return
		const scope = scopes.getStore()
		if (!scope || scope.state.type === 'observed') return
		if (
			input.account?.type !== 'email' ||
			input.account.provider !== options.providerId
		)
			return
		try {
			if (scope.state.type !== 'collecting') throw new Error('Invalid capture')
			const e = scope.state.evidence,
				returned = user.parse(input.user),
				now = z.date().parse(options.now())
			if (
				!e.token ||
				!e.user ||
				!e.session ||
				!isDeepStrictEqual(returned, e.user) ||
				e.token.identifier !== returned.email ||
				e.session.userId !== returned.id ||
				e.token.expires < now ||
				e.session.expires <= now ||
				returned.emailVerified > now
			)
				throw new Error('Incomplete capture')
			const captured: EmailLoginCapture = Object.freeze({
				userId: returned.id,
				email: returned.email,
				verifiedAt: returned.emailVerified.toISOString(),
				acceptedToken: e.token.token,
				sessionToken: e.session.sessionToken,
				sessionExpires: e.session.expires.toISOString(),
			})
			scope.state = { type: 'observed' } // Drop raw snapshots; no repeat observation.
			try {
				const result = await options.writer(captured)
				await diagnose(
					result.type === 'Recorded'
						? 'observation-recorded'
						: result.type === 'Conflict'
							? 'observation-conflict'
							: 'observation-unavailable',
				)
			} catch {
				await diagnose('observation-unavailable')
			}
		} catch {
			scope.state = { type: 'invalid' }
			await diagnose('capture-invalid')
		}
	}
	function wrapSignIn(existing?: SignIn): SignIn {
		if (!options.enabled) return existing ?? (async () => {})
		return async (input) => {
			await existing?.(input) // Preserve failures/order; no observation if this fails.
			try {
				await observe(input)
			} catch {
				await diagnose('observation-unavailable')
			}
		}
	}
	return { run, wrapAdapter, wrapSignIn }
}
