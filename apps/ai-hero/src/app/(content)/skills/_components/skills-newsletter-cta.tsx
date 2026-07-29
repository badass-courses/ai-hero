'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
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

export type SkillsNewsletterCtaState = 'fresh' | 'tag-me' | 'subscribed'
type SkillsNewsletterCtaVariant = 'updates' | 'course'

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
	const { data: subscriber } =
		api.ability.getCurrentSubscriberFromCookie.useQuery(undefined, {
			enabled: !forceState,
		})

	const state: SkillsNewsletterCtaState =
		forceState ??
		(!subscriber || subscriber.state !== 'active'
			? 'fresh'
			: subscriber.fields?.interest === 'skills'
				? 'subscribed'
				: 'tag-me')

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

	if (state === 'tag-me') {
		return (
			<SkillsCtaTagMe
				heading={heading}
				subtitle={subtitle}
				source={source}
				variant={variant}
			/>
		)
	}

	return (
		<aside
			aria-label={
				isCourse ? 'Start the free AI Skills course' : 'Subscribe for skill updates'
			}
			className={cn(
				'not-prose border-primary/30 bg-primary/5 my-10 flex flex-col gap-5 border p-6 sm:p-8',
				!isCourse && 'rounded-xl',
			)}
		>
			<div className="flex flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					{isCourse ? 'AI Hero · Free email course' : 'AI Hero · Skill System'}
				</span>
				<h3 className="text-foreground text-balance font-sans text-2xl font-semibold leading-tight tracking-tight sm:text-[1.625rem]">
					{heading}
				</h3>
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{subtitle}
				</p>
			</div>
			<SubscribeToConvertkitForm
				formId={SKILLS_FORM_ID}
				fields={{ ...SKILLS_INTEREST_FIELDS, source }}
				actionLabel={isCourse ? 'Start the free course' : 'Stay up to date'}
				onSuccess={handleOnSuccess}
				className={cn(
					'[&_button]:bg-primary [&_button]:text-primary-foreground [&_button]:hover:bg-primary/90 [&_input]:border-foreground/15 [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-foreground/60 grid w-full grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] [&_button]:h-12 [&_button]:border-0 [&_button]:px-6 [&_button]:text-sm [&_button]:font-semibold [&_button]:transition [&_input]:h-12 [&_input]:border [&_input]:px-4 [&_input]:text-sm [&_label]:hidden',
					isCourse
						? '[&_button]:rounded-none [&_input]:rounded-none'
						: '[&_button]:rounded-lg [&_input]:rounded-lg',
				)}
			/>
			<p className="text-foreground/60 inline-flex items-center gap-2 text-xs">
				<ShieldCheckIcon className="h-3.5 w-3.5" />
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
}: {
	heading: string
	subtitle: string
	source: string
	variant: SkillsNewsletterCtaVariant
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
				className="not-prose border-border bg-muted/40 my-10 flex flex-col gap-3 border p-6 sm:p-8"
			>
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					{isCourse ? "You're in" : "You're on the list"}
				</span>
				<p className="text-base leading-relaxed opacity-80">
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
			className={cn(
				'not-prose border-primary/30 bg-primary/5 my-10 flex flex-col gap-5 border p-6 sm:p-8',
				variant !== 'course' && 'rounded-xl',
			)}
		>
			<div className="flex flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					{variant === 'course'
						? 'AI Hero · Free email course'
						: 'AI Hero · Skill System'}
				</span>
				<h3 className="text-foreground text-balance font-sans text-2xl font-semibold leading-tight tracking-tight sm:text-[1.625rem]">
					{heading}
				</h3>
				<p className="text-foreground/80 text-balance text-base leading-relaxed">
					{subtitle}
				</p>
			</div>
			<button
				type="button"
				onClick={handleClick}
				disabled={isPending}
				className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring flex h-12 cursor-pointer items-center justify-center px-6 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
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
				<p className="text-destructive text-xs">{error}</p>
			) : (
				<p className="text-foreground/60 inline-flex items-center gap-2 text-xs">
					<ShieldCheckIcon className="h-3.5 w-3.5" />
					<span>
						{variant === 'course'
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
