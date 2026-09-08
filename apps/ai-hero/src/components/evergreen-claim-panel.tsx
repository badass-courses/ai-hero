'use client'

import { useMachine } from '@xstate/react'
import { setup, fromPromise, assign } from 'xstate'
import { TYPE } from '@/components/landing/type'
import { z } from 'zod'

const responseSchema = z
	.object({
		status: z.enum([
			'unavailable',
			'verification-needed',
			'ready',
			'pending',
			'bound',
		]),
		csrf: z.string().optional(),
	})
	.strict()
/** Presentation only: loading → displaying → submitting → displaying/error.
 * No automatic POST/retry/polling; a pending response is never a grant. */
export const evergreenClaimMachine = setup({
	types: {
		context: {} as {
			endpoint: string
			status: z.infer<typeof responseSchema>['status']
			csrf?: string
		},
		input: {} as { endpoint: string },
		events: {} as { type: 'CLAIM' | 'REFRESH' },
	},
	actors: {
		request: fromPromise(
			async ({
				input,
				signal,
			}: {
				input: { endpoint: string; csrf?: string }
				signal: AbortSignal
			}) => {
				const result = await fetch(input.endpoint, {
					method: input.csrf ? 'POST' : 'GET',
					credentials: 'same-origin',
					cache: 'no-store',
					signal,
					headers: input.csrf
						? { 'Content-Type': 'application/json' }
						: undefined,
					body: input.csrf ? JSON.stringify({ csrf: input.csrf }) : undefined,
				})
				return responseSchema.parse(await result.json())
			},
		),
	},
	actions: {
		save: assign(({ event }) => {
			if (!('output' in event)) return {}
			const result = responseSchema.parse(event.output)
			return { status: result.status, csrf: result.csrf }
		}),
	},
	guards: {
		canClaim: ({ context }) =>
			context.status === 'ready' && Boolean(context.csrf),
	},
}).createMachine({
	id: 'evergreen-claim-ui',
	initial: 'loading',
	context: ({ input }) => ({ endpoint: input.endpoint, status: 'unavailable' }),
	states: {
		loading: {
			invoke: {
				src: 'request',
				input: ({ context }) => ({ endpoint: context.endpoint }),
				onDone: { target: 'displaying', actions: 'save' },
				onError: 'error',
			},
		},
		displaying: {
			on: {
				CLAIM: { guard: 'canClaim', target: 'submitting' },
				REFRESH: 'loading',
			},
		},
		submitting: {
			invoke: {
				src: 'request',
				input: ({ context }) => ({
					endpoint: context.endpoint,
					csrf: context.csrf,
				}),
				onDone: { target: 'displaying', actions: 'save' },
				onError: 'error',
			},
		},
		error: { on: { REFRESH: 'loading' } },
	},
})

/** Dormant until explicitly rendered and a real protected endpoint is composed.
 * Fixed local product return path; no email/coupon/account selector props. */
export function EvergreenClaimPanel({
	endpoint,
	productPath,
}: {
	endpoint: string
	productPath: string
}) {
	if (
		!/^\/api\/[a-z0-9/-]+$/.test(endpoint) ||
		!/^\/products\/[a-z0-9-]+$/.test(productPath)
	)
		throw new Error('Invalid local claim route')
	const [state, send] = useMachine(evergreenClaimMachine, {
		input: { endpoint },
	})
	const busy = state.matches('loading') || state.matches('submitting')
	const message = busy
		? 'Checking your offer…'
		: state.matches('error')
			? 'Your offer is unavailable right now.'
			: {
					unavailable: 'We cannot confirm an offer for this account right now.',
					'verification-needed': 'Sign in with your email to check your offer.',
					ready: 'You can request your existing offer.',
					pending: 'Your request is saved. Check its status before continuing.',
					bound: 'Continue using the current checkout price.',
				}[state.context.status]
	const button = `${TYPE.meta} min-h-11 rounded-[9px] border border-input px-4 focus-visible:ring-2 focus-visible:ring-ring`
	return (
		<section className="border-border border-y bg-background text-foreground">
			<div className="space-y-4 px-[18px] py-12 sm:px-11">
				<h2 className={TYPE.heading}>Your offer</h2>
				<p role="status" aria-live="polite" className={TYPE.body}>
					{message}
				</p>
				{!busy && state.context.status === 'ready' && (
					<button className={button} onClick={() => send({ type: 'CLAIM' })}>
						Request my offer
					</button>
				)}
				{!busy && (
					<button className={button} onClick={() => send({ type: 'REFRESH' })}>
						Check status
					</button>
				)}
				{!busy &&
					['unavailable', 'verification-needed'].includes(
						state.context.status,
					) && (
						<p className={TYPE.meta}>
							Already signed in?{' '}
							<a
								className="underline"
								href={`/api/auth/signout?callbackUrl=${encodeURIComponent(`/login?callbackUrl=${encodeURIComponent(productPath)}`)}`}
							>
								Sign out first
							</a>
							, then sign in by email to verify this account.
						</p>
					)}
				<a
					className={`${TYPE.meta} underline`}
					href={`/login?callbackUrl=${encodeURIComponent(productPath)}`}
				>
					Sign in
				</a>
			</div>
		</section>
	)
}
