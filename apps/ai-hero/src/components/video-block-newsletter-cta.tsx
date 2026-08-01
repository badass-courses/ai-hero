'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ConversionIntentButton } from '@/components/cta/conversion-intent-button'
import { ConversionIntentForm } from '@/components/cta/conversion-intent-form'
import { redirectUrlBuilder } from '@/convertkit'
import { Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import {
	InformationCircleIcon,
	ShieldCheckIcon,
} from '@heroicons/react/24/outline'
import { useSession } from 'next-auth/react'
import ReactMarkdown from 'react-markdown'
import { twMerge } from 'tailwind-merge'

import common from '../text/common'

type VideoBlockNewsletterCtaProps = {
	onSuccess?: (subscriber?: Subscriber) => void
	/**
	 * Called when a KNOWN reader subscribes with one click. Separate from
	 * `onSuccess` because the server action resolves their identity from the
	 * cookie or session and returns no `Subscriber` record for the browser to
	 * hand over — the caller reacts to the fact, not the record.
	 */
	onKnownSuccess?: (result: { confirmationRequired: boolean }) => void
	title?: string
	byline?: string
	actionLabel?: string
	id?: string
	className?: string
	trackProps?: {
		event?: string
		params?: Record<string, string>
	}
	moduleTitle?: string
}

export const VideoBlockNewsletterCta: React.FC<
	React.PropsWithChildren<VideoBlockNewsletterCtaProps>
> = ({
	children,
	className,
	id = 'video-block-newsletter-cta',
	moduleTitle = 'No Title',

	actionLabel = common['video-block-newsletter-button-cta-label'],
	trackProps = { event: 'subscribed', params: {} },
	onSuccess,
	onKnownSuccess,
}) => {
	const router = useRouter()
	// A signed-in viewer must not be asked to type the address they signed in
	// with. The session is the client-side signal; the server action re-resolves
	// identity on its own terms and `onNotIdentified` drops back to the form if
	// the session turned out stale.
	const { status: sessionStatus } = useSession()
	const [requiresIdentityForm, setRequiresIdentityForm] = React.useState(false)

	const handleOnSuccess = (subscriber: Subscriber | undefined) => {
		if (subscriber) {
			track(trackProps.event as string, trackProps.params)
			const redirectUrl = redirectUrlBuilder(subscriber, '/confirm')
			router.push(redirectUrl)
		}
	}

	return (
		<div
			id={id}
			aria-label="Newsletter sign-up"
			className={twMerge(
				'flex grid-cols-2 flex-col items-center justify-center gap-10 lg:grid',
				className,
			)}
		>
			<div className="flex w-full flex-col items-center justify-center gap-2 md:gap-5">
				{children}
				<strong className="text-balance text-center text-xl font-semibold lg:text-2xl">
					{common['video-block-newsletter-tittle'](moduleTitle)}
				</strong>
				{sessionStatus === 'authenticated' && !requiresIdentityForm ? (
					<ConversionIntentButton
						intent={{ kind: 'newsletter' }}
						surface="video-block"
						label={actionLabel}
						className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex h-12 w-full max-w-sm cursor-pointer items-center justify-center rounded-md px-6 text-base font-semibold transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60"
						onSuccess={(result) => {
							track(trackProps.event as string, {
								...trackProps.params,
								method: 'one-click',
							})
							onKnownSuccess?.(result)
						}}
						onNotIdentified={() => setRequiresIdentityForm(true)}
					/>
				) : (
					<ConversionIntentForm
						intent={{ kind: 'newsletter' }}
						surface="video-block"
						onSuccess={
							onSuccess ? (subscriber) => onSuccess(subscriber) : handleOnSuccess
						}
						actionLabel={actionLabel}
					/>
				)}
				<p
					data-nospam=""
					className="inline-flex items-center gap-1 pt-0 text-left text-sm opacity-75"
				>
					<ShieldCheckIcon className="h-4 w-4" aria-hidden="true" /> I respect
					your privacy. Unsubscribe at any time.
				</p>
			</div>
			<div>
				<strong className="mb-4 inline-flex gap-1 text-lg font-medium">
					<InformationCircleIcon className="w-5" /> This is a free tutorial
				</strong>
				<ReactMarkdown className="prose dark:prose-invert">
					{common['video-block-newsletter-description']}
				</ReactMarkdown>
			</div>
		</div>
	)
}
