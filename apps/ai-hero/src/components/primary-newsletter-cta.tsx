'use client'

import * as React from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ShinyText } from '@/app/admin/pages/_components/page-builder-mdx-components'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { Subscriber } from '@/schemas/subscriber'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { LockIcon, ShieldCheckIcon } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { twMerge } from 'tailwind-merge'

import { cn } from '@coursebuilder/utils/cn'

import common from '../text/common'
import { CldImage } from './cld-image'

type PrimaryNewsletterCtaProps = {
	onSuccess?: () => void
	/**
	 * Accepts a ReactNode so SERVER call sites can pass the live-count title
	 * (`title={<PrimaryNewsletterTitle />}` from subscriber-count.tsx). The
	 * string default below is a static fallback only — this is a client
	 * component and can't fetch the Kit count itself.
	 */
	title?: React.ReactNode
	byline?: string
	actionLabel?: string
	/**
	 * Heading element used for the CTA title. Defaults to `h2`; use `h1` when the CTA supplies the page's primary heading.
	 */
	titleElement?: 'h1' | 'h2'
	id?: string
	className?: string
	trackProps?: {
		event?: string
		params?: Record<string, string>
	}
	resource?: {
		path: string
		title: string
	}
	formId?: number
	fields?: Record<string, string>
	isHiddenForSubscribers?: boolean
	reserveSpaceWhenHidden?: boolean
}

/**
 * Primary ConvertKit newsletter CTA component.
 *
 * Uses `titleElement` to keep page heading semantics correct while reusing the same visual CTA.
 */
export const PrimaryNewsletterCta: React.FC<
	React.PropsWithChildren<PrimaryNewsletterCtaProps>
> = ({
	resource,
	children,
	className,
	id = 'primary-newsletter-cta',
	title = common['primary-newsletter-tittle'],
	byline = common['primary-newsletter-byline'],
	actionLabel = common['primary-newsletter-button-cta-label'],
	titleElement = 'h2',
	trackProps = { event: 'subscribed', params: {} },
	isHiddenForSubscribers = false,
	reserveSpaceWhenHidden = false,
	formId,
	fields,
	onSuccess,
}) => {
	const router = useRouter()
	const { data: subscriber, status } =
		api.ability.getCurrentSubscriberFromCookie.useQuery()

	const handleOnSuccess = (subscriber: Subscriber | undefined) => {
		if (subscriber) {
			track(trackProps.event as string, trackProps.params)
			const redirectUrl = redirectUrlBuilder(subscriber, '/confirm')
			router.push(redirectUrl)
		}
	}
	const { data: session } = useSession()

	const shouldHideForSubscriber = isHiddenForSubscribers && subscriber
	const Title = titleElement

	if (shouldHideForSubscriber && !reserveSpaceWhenHidden) {
		return null
	}

	return (
		<section
			// data-theme="elysium"
			id={id}
			aria-label="Newsletter sign-up"
			aria-hidden={shouldHideForSubscriber ? true : undefined}
			className={cn(
				'flex flex-col items-center justify-center px-5',
				{
					'pointer-events-none invisible select-none': shouldHideForSubscriber,
				},
				className,
			)}
		>
			{children ? (
				children
			) : (
				<div className="relative z-10 flex max-w-3xl flex-col items-center justify-center pb-5 sm:pb-10">
					{/* <CldImage
						loading="lazy"
						src="https://res.cloudinary.com/total-typescript/image/upload/v1741008166/aihero.dev/assets/textured-logo-mark_2x_ecauns.png"
						alt=""
						aria-hidden="true"
						width={130}
						height={130}
						className="mb-8 rotate-12"
					/> */}
					<Title className="text-center text-3xl font-semibold tracking-tight sm:text-3xl lg:text-4xl dark:text-white">
						{title}
					</Title>
					<h3 className="dark:text-primary pt-3 text-center font-sans text-base font-normal tracking-tight sm:pt-5 sm:text-lg lg:text-xl dark:brightness-110 dark:sm:font-light [&_strong]:font-bold">
						{byline}
					</h3>
				</div>
			)}

			<div className="not-prose relative flex w-full items-center justify-center">
				{subscriber && (
					<div className="absolute z-10 flex -translate-y-8 flex-col text-center">
						<ShinyText className="text-lg font-semibold sm:text-lg lg:text-xl">
							You're subscribed, thanks!
						</ShinyText>
						<p className="pt-3 text-center font-sans text-lg font-normal opacity-90 sm:text-base lg:text-lg">
							{session?.user
								? common['newsletter-subscribed-logged-in']({
										resource,
									})
								: common['newsletter-subscribed-logged-out']({
										resource,
									})}
						</p>
					</div>
				)}
				<div
					className={cn('flex w-full flex-col items-center justify-center', {
						'blur-xs pointer-events-none select-none opacity-75 transition ease-in-out':
							subscriber,
					})}
				>
					<SubscribeToConvertkitForm
						onSuccess={onSuccess ? onSuccess : handleOnSuccess}
						actionLabel={actionLabel}
						formId={formId}
						fields={fields}
						className="[&_input]:ring-foreground/20 [&_input]:bg-background/30 relative z-10 [&_button]:mt-3 [&_button]:h-16 [&_button]:sm:text-lg [&_input]:h-16 [&_input]:border-none [&_input]:bg-blend-hard-light [&_input]:ring-1 [&_input]:backdrop-blur-xl"
					/>
					<p
						data-nospam=""
						className="text-foreground/80 inline-flex items-center pt-8 text-xs sm:text-sm"
					>
						<ShieldCheckIcon className="mr-2 h-4 w-4" /> I respect your privacy.
						Unsubscribe at any time.
					</p>
				</div>
			</div>
		</section>
	)
}
