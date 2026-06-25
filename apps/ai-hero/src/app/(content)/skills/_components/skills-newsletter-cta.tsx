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

import { tagSubscriberAsSkills } from './skills-newsletter-actions'
import {
	SKILLS_FORM_ID,
	SKILLS_INTEREST_FIELDS,
} from './skills-newsletter-config'

export type SkillsNewsletterCtaState = 'fresh' | 'tag-me' | 'subscribed'

export function SkillsNewsletterCta({
	heading = 'Get the next skill update in your inbox',
	subtitle = 'New skill posts and changelog notes from Matt, on the agentic dev workflow.',
	forceState,
}: {
	heading?: string
	subtitle?: string
	forceState?: SkillsNewsletterCtaState
}) {
	const router = useRouter()
	const { data: subscriber } =
		api.ability.getCurrentSubscriberFromCookie.useQuery(undefined, {
			enabled: !forceState,
		})

	const state: SkillsNewsletterCtaState =
		forceState ??
		(!subscriber
			? 'fresh'
			: subscriber.fields?.interest === 'skills'
				? 'subscribed'
				: 'tag-me')

	const handleOnSuccess = (subscriber: Subscriber | undefined) => {
		if (subscriber) {
			track('subscribed', { location: 'mdx_inline_skills' })
			router.push(redirectUrlBuilder(subscriber, '/confirm'))
		}
	}

	if (state === 'subscribed') {
		return null
	}

	if (state === 'tag-me') {
		return <SkillsCtaTagMe heading={heading} subtitle={subtitle} />
	}

	return (
		<aside
			aria-label="Subscribe for skill updates"
			className="not-prose border-primary/30 bg-primary/5 my-10 flex flex-col gap-5 rounded-xl border p-6 sm:p-8"
		>
			<div className="flex flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					AI Hero · Skill System
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
				fields={{ ...SKILLS_INTEREST_FIELDS, source: 'mdx_inline_skills' }}
				actionLabel="Stay up to date"
				onSuccess={handleOnSuccess}
				className="[&_button]:bg-primary [&_button]:text-primary-foreground [&_button]:hover:bg-primary/90 [&_input]:border-foreground/15 [&_input]:bg-background [&_input]:text-foreground [&_input]:placeholder:text-foreground/60 grid w-full grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] [&_button]:h-12 [&_button]:rounded-lg [&_button]:border-0 [&_button]:px-6 [&_button]:text-sm [&_button]:font-semibold [&_button]:transition [&_input]:h-12 [&_input]:rounded-lg [&_input]:border [&_input]:px-4 [&_input]:text-sm [&_label]:hidden"
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
}: {
	heading: string
	subtitle: string
}) {
	const [isPending, startTransition] = React.useTransition()
	const [error, setError] = React.useState<string | null>(null)
	const [done, setDone] = React.useState(false)

	const handleClick = () => {
		setError(null)
		startTransition(async () => {
			const result = await tagSubscriberAsSkills()
			if (result.success) {
				track('subscribed', { location: 'mdx_inline_skills', method: 'tag-me' })
				setDone(true)
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
		return (
			<aside
				aria-label="Skills updates"
				className="not-prose border-border bg-muted/40 my-10 flex flex-col gap-3 border p-6 sm:p-8"
			>
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
					You're on the list
				</span>
				<p className="text-base leading-relaxed opacity-80">
					Skill updates will land in your inbox.{' '}
					<Link
						href="/skills"
						className="text-foreground inline-flex items-center gap-1 underline underline-offset-4 hover:no-underline"
					>
						Browse the skill set
						<ArrowUpRight className="size-3.5" />
					</Link>
				</p>
			</aside>
		)
	}

	return (
		<aside
			aria-label="Add me to the skills list"
			className="not-prose border-primary/30 bg-primary/5 my-10 flex flex-col gap-5 rounded-xl border p-6 sm:p-8"
		>
			<div className="flex flex-col gap-2">
				<span className="text-primary font-mono text-[11px] font-medium uppercase tracking-wider">
					AI Hero · Skill System
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
				{isPending ? <Spinner className="h-4 w-4" /> : 'Send me skill updates'}
			</button>
			{error ? (
				<p className="text-destructive text-xs">{error}</p>
			) : (
				<p className="text-foreground/60 inline-flex items-center gap-2 text-xs">
					<ShieldCheckIcon className="h-3.5 w-3.5" />
					<span>
						You're already subscribed — one click to get on the skills list.
					</span>
				</p>
			)}
		</aside>
	)
}
