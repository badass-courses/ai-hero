'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { TYPE } from '@/components/landing/type'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { Subscriber } from '@/schemas/subscriber'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { useSession } from 'next-auth/react'

import { cn } from '@coursebuilder/utils/cn'

import common from '../text/common'

type PrimaryNewsletterCtaProps = {
	onSuccess?: () => void
	/**
	 * Accepts a ReactNode so SERVER call sites can pass the live-count title
	 * (`title={<PrimaryNewsletterTitle />}` from subscriber-count.tsx). The
	 * string default below is a static fallback only — this is a client
	 * component and can't fetch the Kit count itself.
	 */
	title?: React.ReactNode
	byline?: React.ReactNode
	/** The mono eyebrow above the title. Pass `null` to drop it. */
	label?: React.ReactNode
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
 * The site's primary Kit (ConvertKit) newsletter ask.
 *
 * It is a PANEL, not a band: a bordered card on `--ah-band` carrying a mono
 * eyebrow, a `panelTitle` headline, one line of byline, the 44px control row
 * and a mono privacy note. Same shape as `NewsletterSection` on the landing
 * page and `PostNewsletterForm` in an article's "Keep learning" cell, so the
 * one offer reads the same wherever it appears.
 *
 * `children` replaces the eyebrow/title/byline stack only — the form, the
 * subscriber branch and the panel chrome stay put, so a call site can supply
 * its own pitch without re-deriving the panel.
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
	label = 'Newsletter',
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
	const { data: subscriber } =
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
			id={id}
			aria-label="Newsletter sign-up"
			aria-hidden={shouldHideForSubscriber ? true : undefined}
			className={cn(
				'flex flex-col items-center px-5',
				{
					'pointer-events-none invisible select-none': shouldHideForSubscriber,
				},
				className,
			)}
		>
			<div className="border-border w-full max-w-[720px] rounded-lg border bg-[color:var(--ah-band)] px-6 py-6 sm:px-8 sm:py-[30px]">
				{children ? (
					children
				) : (
					<>
						{label && (
							<p
								className={cn(
									TYPE.micro,
									'mb-3 text-[color:var(--ah-fg-label)]',
								)}
							>
								{label}
							</p>
						)}
						<Title className={cn(TYPE.panelTitle, 'text-balance font-sans')}>
							{title}
						</Title>
						{byline && (
							<p
								className={cn(
									TYPE.metaProse,
									'mt-2 max-w-[56ch] text-pretty text-[color:var(--ah-fg-muted)]',
								)}
							>
								{byline}
							</p>
						)}
					</>
				)}

				<div className="not-prose mt-5">
					{subscriber ? (
						<p
							className={cn(
								TYPE.metaProse,
								'text-[color:var(--ah-fg-muted)]',
							)}
						>
							You&rsquo;re subscribed, thanks.{' '}
							{session?.user
								? common['newsletter-subscribed-logged-in']({ resource })
								: common['newsletter-subscribed-logged-out']({ resource })}
						</p>
					) : (
						<>
							<SubscribeToConvertkitForm
								onSuccess={onSuccess ? onSuccess : handleOnSuccess}
								actionLabel={actionLabel}
								formId={formId}
								fields={fields}
								className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_button]:shadow-none [&_input]:border-input [&_input]:bg-background [&_input]:text-foreground grid w-full grid-cols-1 gap-2.5 desk:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)_auto] [&_button]:h-[50px] desk:[&_button]:h-11 [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-[18px] [&_button]:text-sm [&_button]:font-bold [&_input]:h-12 desk:[&_input]:h-11 [&_input]:min-w-0 [&_input]:rounded-[9px] [&_input]:border [&_input]:px-3.5 [&_input]:text-sm [&_input]:placeholder:text-[color:var(--ah-fg-faint)] [&_label]:hidden"
							/>
							<p
								data-nospam=""
								className={cn(
									TYPE.command,
									'mt-3 text-[color:var(--ah-fg-faint)]',
								)}
							>
								No spam. Unsubscribe anytime.
							</p>
						</>
					)}
				</div>
			</div>
		</section>
	)
}
