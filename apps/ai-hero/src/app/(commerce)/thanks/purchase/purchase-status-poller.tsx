'use client'

import * as React from 'react'
import Spinner from '@/components/spinner'

type CheckoutStatus =
	| { status: 'ready'; purchaseId: string }
	| { status: 'processing' }
	| { status: 'payment_succeeded_processing_failed' }
	| { status: 'error'; message: string }

type PurchaseStatusPollerProps = {
	sessionId: string
}

/**
 * Polls the checkout status endpoint until the webhook-created purchase exists.
 *
 * @param props - Component props.
 * @param props.sessionId - Stripe Checkout Session ID from the thank-you page URL.
 * @returns A processing UI that redirects to the final thank-you render when ready.
 *
 * @remarks Starts polling on mount, stops polling on unmount, caps retry attempts,
 * and shows support copy instead of polling forever when setup takes too long or
 * repeated network/API errors occur.
 */
export function PurchaseStatusPoller({ sessionId }: PurchaseStatusPollerProps) {
	const [attempts, setAttempts] = React.useState(0)
	const [statusMessage, setStatusMessage] = React.useState(
		'Finalizing your purchase...',
	)
	const [errorMessage, setErrorMessage] = React.useState<string | null>(null)

	React.useEffect(() => {
		let cancelled = false
		let timeoutId: ReturnType<typeof setTimeout> | undefined

		const poll = async (attempt: number) => {
			try {
				const params = new URLSearchParams({
					session_id: sessionId,
					attempt: String(attempt),
				})
				const response = await fetch(
					`/api/commerce/checkout-status?${params.toString()}`,
					{
						cache: 'no-store',
					},
				)

				const result = (await response
					.json()
					.catch(() => null)) as CheckoutStatus | null

				if (cancelled) return

				if (!response.ok) {
					setErrorMessage(
						result?.status === 'error'
							? result.message
							: 'We could not check your purchase status. Please refresh or contact support.',
					)
					return
				}

				if (!result) {
					setErrorMessage(
						'We could not read your purchase status. Please refresh or contact support.',
					)
					return
				}

				if (result.status === 'ready') {
					const nextUrl = new URL(window.location.href)
					nextUrl.searchParams.set('ready', '1')
					window.location.replace(nextUrl.toString())
					return
				}

				if (result.status === 'payment_succeeded_processing_failed') {
					const nextUrl = new URL(window.location.href)
					nextUrl.searchParams.set('ready', '1')
					window.location.replace(nextUrl.toString())
					return
				}

				if (result.status === 'error') {
					setErrorMessage(result.message)
					return
				}

				const nextAttempt = attempt + 1
				setAttempts(nextAttempt)

				if (nextAttempt > 10) {
					setStatusMessage('Still setting up your access...')
				}

				if (nextAttempt > 45) {
					setErrorMessage(
						'Your payment succeeded, but setup is taking longer than expected. Please check your email for the login link or contact support.',
					)
					return
				}

				timeoutId = setTimeout(
					() => poll(nextAttempt),
					Math.min(1000 + nextAttempt * 250, 3000),
				)
			} catch (error) {
				if (cancelled) return
				const nextAttempt = attempt + 1
				setAttempts(nextAttempt)

				if (nextAttempt > 45) {
					setErrorMessage(
						'Your payment succeeded, but setup is taking longer than expected. Please check your email for the login link or contact support.',
					)
					return
				}

				timeoutId = setTimeout(() => poll(nextAttempt), 2000)
			}
		}

		void poll(0)

		return () => {
			cancelled = true
			if (timeoutId) clearTimeout(timeoutId)
		}
	}, [sessionId])

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-5 text-center">
			<h1 className="text-lg font-medium leading-tight tracking-tight sm:text-xl lg:text-2xl">
				Payment received
			</h1>
			<div className="mx-auto">
				<Spinner className="text-center" />
			</div>
			<p className="max-w-prose text-sm text-muted-foreground sm:text-base">
				{errorMessage ?? statusMessage}
			</p>
			{!errorMessage && attempts > 5 && (
				<p className="max-w-prose text-xs text-muted-foreground">
					This usually takes a few seconds. You can leave this tab open while we
					finish setup.
				</p>
			)}
		</div>
	)
}
