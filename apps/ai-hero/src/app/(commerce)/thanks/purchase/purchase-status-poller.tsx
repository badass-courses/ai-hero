'use client'

import * as React from 'react'
import { useMachine } from '@xstate/react'
import { PostPurchaseShell } from '../../_components/post-purchase-shell'
import { createPurchaseWaitLogger } from '../../_components/post-purchase-telemetry'
import {
	CheckoutStatusSchema,
	createPurchaseWaitMachine,
} from './purchase-wait-machine'

export function PurchaseStatusPoller({ sessionId }: { sessionId: string }) {
	const logger = React.useMemo(
		() => createPurchaseWaitLogger(sessionId),
		[sessionId],
	)
	const machine = React.useMemo(
		() =>
			createPurchaseWaitMachine({
				logger,
				check: async (attempt, signal) => {
					const params = new URLSearchParams({
						session_id: sessionId,
						attempt: String(attempt),
					})
					const response = await fetch(
						`/api/commerce/checkout-status?${params}`,
						{ cache: 'no-store', signal },
					)
					const result = CheckoutStatusSchema.safeParse(await response.json())
					if (!response.ok || !result.success)
						return {
							status: 'error' as const,
							message:
								'We could not check your purchase status. Please try again or contact support.',
						}
					return result.data
				},
			}),
		[sessionId, logger],
	)
	const [state, send] = useMachine(machine)
	React.useEffect(() => {
		logger('client_returned')
	}, [logger])
	React.useEffect(() => {
		if (!state.matches('ready')) return
		const nextUrl = new URL(window.location.href)
		nextUrl.searchParams.set('ready', '1')
		// Keep the server-owned session/ownership handoff. Client navigation must
		// not skip the login-link branch for a buyer without a proven session.
		const navigation = window.setTimeout(
			() => window.location.replace(nextUrl.toString()),
			window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350,
		)
		return () => window.clearTimeout(navigation)
	}, [state])
	const result = state.context.result
	return (
		<PostPurchaseShell
			step={
				state.matches('failed')
					? 'failed'
					: state.matches('ready')
						? 'ready'
						: state.context.slow
							? 'slow'
							: 'processing'
			}
			title={result?.status === 'ready' ? result.product?.name : undefined}
			image={result?.status === 'ready' ? result.product?.image : undefined}
			message={state.context.message ?? undefined}
			onRetry={() => send({ type: 'RETRY' })}
		/>
	)
}
