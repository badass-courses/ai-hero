'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BADGE_NEUTRAL, TYPE } from '@/components/landing/type'
import Spinner from '@/components/spinner'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { Subscriber } from '@/schemas/subscriber'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { ArrowUpRight, ShieldCheckIcon } from 'lucide-react'

import { cn } from '@coursebuilder/utils/cn'

import { tagSubscriberAsSkills } from './skills-newsletter-actions'
import {
	SKILLS_FORM_ID,
	SKILLS_HOSTED_RESUBSCRIBE_URL,
	SKILLS_INTEREST_FIELDS,
} from './skills-newsletter-config'

/**
 * `tag-me`  — on the AI Hero list, not yet on the skills course.
 * `account` — signed in, so the address is known, but not on the list at all.
 * Both are one click; only `tag-me` may claim they are already subscribed.
 */
export type SkillsNewsletterCtaState =
	| 'fresh'
	| 'tag-me'
	| 'account'
	| 'subscribed'
type SkillsNewsletterCtaVariant = 'updates' | 'course'

/**
 * The card's own type, from the scale rather than from inline sizes.
 *
 * Every line in here used to name its own size and weight — `text-2xl
 * font-semibold` on the heading, `text-base` on the lead, `text-sm
 * font-semibold` on the button, `text-[11px] tracking-wider` on the eyebrow.
 * None of those are steps in `TYPE`, so the card was set in four sizes the rest
 * of the site does not use.
 *
 * The button keeps a weight of its own on top of `TYPE.meta` — see
 * `CARD_BUTTON`. The scale sets type; what a gold fill weighs is a property of
 * the control, and every other one on the site is 700.
 *
 * `panelTitle` is the documented step for "a bordered panel's own title", which
 * is exactly what this is.
 */
// A group label, not an eyebrow: it names the offer in the panel under it,
// and the card already carries a surface of its own.
const CARD_EYEBROW = cn(TYPE.groupLabel, 'text-primary')
/** Which offer the card is making, in the eyebrow. */
const cardEyebrow = (variant: SkillsNewsletterCtaVariant) =>
	variant === 'course'
		? 'AI Hero · Free email course'
		: 'AI Hero · Skill System'
const CARD_HEADING = cn(TYPE.panelTitle, 'text-foreground text-balance')
const CARD_LEAD = cn(TYPE.lead, 'text-foreground/80 text-balance')
const CARD_FOOTNOTE = cn(
	TYPE.metaSm,
	'text-foreground/60 inline-flex items-center gap-2',
)
/**
 * 48px gold control, 9px radius, sized by its label. Shared by both states.
 *
 * `font-bold`, which is what every other gold fill on the site is set in — the
 * hero CTAs, the cohort asks, the skills course form. `TYPE.meta` ships 500 and
 * this used to inherit it, so the one control in the card came out two steps
 * lighter than the identical-looking button a page away.
 */
const CARD_BUTTON = cn(
	TYPE.meta,
	'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover focus-visible:ring-ring inline-flex h-12 items-center justify-center rounded-[9px] px-7 font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
)

export function SkillsNewsletterCta({
	heading = 'Get the next skill update in your inbox',
	subtitle = 'New skill posts and changelog notes from Matt, on the agentic dev workflow.',
	source = 'mdx_inline_skills',
	variant = 'updates',
	forceState,
}: {
	heading?: string
	subtitle?: string
	source?: string
	variant?: SkillsNewsletterCtaVariant
	forceState?: SkillsNewsletterCtaState
}) {
	const router = useRouter()
	const isCourse = variant === 'course'
	const eyebrow = cardEyebrow(variant)
	// Resolved on the SERVER, from the Kit cookie or the session, because only
	// the server can see the session — the old client-side derivation from the
	// cookie alone is what sent signed-in readers to the form.
	const { data: ctaState } = api.ability.getSkillsCourseCtaState.useQuery(
		undefined,
		{ enabled: !forceState },
	)

	const state: SkillsNewsletterCtaState = forceState ?? ctaState?.state ?? 'fresh'

	const handleOnSuccess = (subscriber: Subscriber | undefined) => {
		if (!subscriber) return
		if (subscriber.state !== 'active') {
			window.location.assign(SKILLS_HOSTED_RESUBSCRIBE_URL)
			return
		}
		track('subscribed', { location: source })
		router.push(
			redirectUrlBuilder(
				subscriber,
				'/confirm',
				isCourse ? { flow: 'course' } : undefined,
			),
		)
	}

	if (state === 'subscribed') {
		return null
	}

	// Both are one-click: the reader is identified, so there is nothing to type.
	// They differ only in what the footnote can honestly claim — see `knownVia`.
	if (state === 'tag-me' || state === 'account') {
		return (
			<SkillsCtaTagMe
				heading={heading}
				subtitle={subtitle}
				source={source}
				variant={variant}
				knownVia={state === 'account' ? 'account' : 'list'}
			/>
		)
	}

	return (
		<aside
			aria-label={
				isCourse ? 'Start the free AI Skills course' : 'Subscribe for skill updates'
			}
			// `rounded-xl` for both offers: the course variant shipped square, so a
			// reader scrolling from a skill page to an article met the same card in
			// two different shapes.
			className="not-prose border-primary/30 bg-primary/5 my-10 flex flex-col gap-5 rounded-xl border p-6 sm:p-8"
		>
			<div className="flex flex-col gap-2">
				<span className={CARD_EYEBROW}>{eyebrow}</span>
				{/* `font-sans` is load-bearing: the global `h1..h6` rule sets
				    `--font-heading`, and this card's title is UI type, not a
				    document heading. */}
				<h3 className={cn(CARD_HEADING, 'font-sans')}>{heading}</h3>
				<p className={CARD_LEAD}>{subtitle}</p>
			</div>
			<SubscribeToConvertkitForm
				formId={SKILLS_FORM_ID}
				fields={{ ...SKILLS_INTEREST_FIELDS, source }}
				actionLabel={isCourse ? 'Start the free course' : 'Stay up to date'}
				onSuccess={handleOnSuccess}
				// One form treatment for both offers. The course variant used to render
				// square with a `bg-primary` semibold button while the updates variant
				// was rounded and gold — the same form, two shapes and two weights,
				// depending on which copy it carried. 9px and `accent-fill` are the
				// documented control, so both use it.
				className="[&_button]:bg-accent-fill [&_button]:text-accent-fill-foreground [&_button]:hover:bg-accent-fill-hover [&_input]:border-foreground/15 [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-foreground/60 grid w-full grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] [&_button]:h-12 [&_button]:rounded-[9px] [&_button]:border-0 [&_button]:px-7 [&_button]:text-sm [&_button]:font-bold [&_button]:leading-snug [&_button]:transition [&_input]:h-12 [&_input]:rounded-[9px] [&_input]:min-w-0 [&_input]:border [&_input]:px-5 [&_input]:text-sm [&_label]:sr-only"
			/>
			<p className={CARD_FOOTNOTE}>
				<ShieldCheckIcon className="h-3.5 w-3.5 shrink-0" />
				<span>I respect your privacy. Unsubscribe at any time.</span>
			</p>
		</aside>
	)
}

function SkillsCtaTagMe({
	heading,
	subtitle,
	source,
	variant,
	knownVia = 'list',
}: {
	heading: string
	subtitle: string
	source: string
	variant: SkillsNewsletterCtaVariant
	/**
	 * How we know this reader, which is the only thing the footnote may assert.
	 * `list` — already an AI Hero subscriber. `account` — signed in, and not
	 * necessarily subscribed to anything, so it must not say they are.
	 */
	knownVia?: 'list' | 'account'
}) {
	const [isPending, startTransition] = React.useTransition()
	const [error, setError] = React.useState<string | null>(null)
	const [done, setDone] = React.useState(false)

	const handleClick = () => {
		setError(null)
		startTransition(async () => {
			const result = await tagSubscriberAsSkills(source)
			if (result.success) {
				track('subscribed', { location: source, method: 'tag-me' })
				setDone(true)
			} else if (result.reason === 'confirmation-required') {
				window.location.assign(result.confirmationUrl)
			} else {
				setError(
					result.reason === 'not-subscribed'
						? 'We could not find your subscription — try the form instead.'
						: 'Something went wrong. Please try again.',
				)
			}
		})
	}

	if (done) {
		const isCourse = variant === 'course'
		return (
			<aside
				aria-label={isCourse ? 'Course enrolment' : 'Skills updates'}
				// Same box as the two states above it — `rounded-xl` is the shared
				// shape for every inline MDX card (`PromoCard`, `SkillsCta`,
				// `SkillsCourseCta`). This one was square, so confirming the
				// subscription visibly changed the card's shape under the reader.
				className="not-prose border-border bg-muted/40 my-10 flex flex-col gap-3 rounded-xl border p-6 sm:p-8"
			>
				<span className={cn(TYPE.badge, BADGE_NEUTRAL, 'inline-flex w-fit')}>
					{isCourse ? "You're in" : "You're on the list"}
				</span>
				<p className={cn(TYPE.lead, 'opacity-80')}>
					{isCourse ? (
						'Lesson one is on the way.'
					) : (
						<>
							Skill updates will land in your inbox.{' '}
							<Link
								href="/skills"
								className="text-foreground inline-flex items-center gap-1 underline underline-offset-4 hover:no-underline"
							>
								Browse the skill set
								<ArrowUpRight className="size-3.5" />
							</Link>
						</>
					)}
				</p>
			</aside>
		)
	}

	return (
		<aside
			aria-label={
				variant === 'course'
					? 'Join the free AI Skills course'
					: 'Add me to the skills list'
			}
			className="not-prose border-primary/30 bg-primary/5 my-10 flex flex-col gap-5 rounded-xl border p-6 sm:p-8"
		>
			<div className="flex flex-col gap-2">
				<span className={CARD_EYEBROW}>{cardEyebrow(variant)}</span>
				<h3 className={cn(CARD_HEADING, 'font-sans')}>{heading}</h3>
				<p className={CARD_LEAD}>{subtitle}</p>
			</div>
			{/* The same object as the subscribe form's submit in the `fresh` state
			    above — same gold fill, same 48px height, same 9px radius, same
			    padding. It is the one action in the card either way; which of the
			    two cards the reader gets is not something the button should
			    announce.

			    `self-start` because the card is a `flex-col`: a bare `flex` here
			    stretched the button across the whole panel, so a one-word action
			    read as a banner. `inline-flex` keeps it sized by its label, and the
			    `min-w` holds the box steady when the label swaps for the spinner. */}
			<button
				type="button"
				onClick={handleClick}
				disabled={isPending}
				className={cn(
					CARD_BUTTON,
					'min-w-[196px] cursor-pointer select-none self-start disabled:cursor-not-allowed disabled:opacity-60',
				)}
			>
				{isPending ? (
					<Spinner className="h-4 w-4" />
				) : variant === 'course' ? (
					'Start the free course'
				) : (
					'Send me skill updates'
				)}
			</button>
			{error ? (
				<p className={cn(TYPE.metaSm, 'text-destructive')}>{error}</p>
			) : (
				<p className={CARD_FOOTNOTE}>
					<ShieldCheckIcon className="h-3.5 w-3.5 shrink-0" />
					{/* Only `list` may say "already subscribed". An `account` reader is
					    signed in and may be on no list at all, so it says what is
					    actually true — we have their address and will not ask for it. */}
					<span>
						{knownVia === 'account'
							? variant === 'course'
								? "We'll use your account email. One click starts the course."
								: "We'll use your account email — one click to get skill updates."
							: variant === 'course'
								? "You're already subscribed. One click starts the course."
								: "You're already subscribed — one click to get on the skills list."}
					</span>
				</p>
			)}
		</aside>
	)
}

export function SkillsCourseCta({
	headline,
	subtitle,
	source,
	forceState,
}: {
	headline: string
	subtitle: string
	source: string
	forceState?: SkillsNewsletterCtaState
}) {
	return (
		<SkillsNewsletterCta
			heading={headline}
			subtitle={subtitle}
			source={source}
			variant="course"
			forceState={forceState}
		/>
	)
}
