'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ThemeImage } from '@/components/cld-image'
import Spinner from '@/components/spinner'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import { ShieldCheckIcon } from 'lucide-react'

import { cn } from '@coursebuilder/ui/utils/cn'

import { tagSubscriberAsSkills } from './skills-newsletter-actions'
import {
	SKILLS_FORM_ID,
	SKILLS_INTEREST_FIELDS,
} from './skills-newsletter-config'

export const SKILLS_NEWSLETTER_IMAGE = {
	dark: 'https://res.cloudinary.com/total-typescript/image/upload/v1777381174/skills-newsletter-dark.png',
	light:
		'https://res.cloudinary.com/total-typescript/image/upload/v1777381174/skills-newsletter-light.png',
}

export type SkillsNewsletterStatus = 'show-form' | 'tag-me' | 'subscribed'

interface SkillsNewsletterContextValue {
	state: {
		status: SkillsNewsletterStatus
		isPending: boolean
		error: string | null
	}
	actions: {
		tagMe: () => void
		handleFormSuccess: (subscriber: Subscriber | undefined) => void
	}
	meta: {
		location: string
	}
}

const SkillsNewsletterContext =
	React.createContext<SkillsNewsletterContextValue | null>(null)

export function useSkillsNewsletter() {
	const ctx = React.use(SkillsNewsletterContext)
	if (!ctx) {
		throw new Error(
			'SkillsNewsletter.* parts must be used inside <SkillsNewsletter.Root>',
		)
	}
	return ctx
}

export function Root({
	status,
	location,
	children,
}: {
	status: SkillsNewsletterStatus
	location: string
	children: React.ReactNode
}) {
	const router = useRouter()
	const [isPending, startTransition] = React.useTransition()
	const [error, setError] = React.useState<string | null>(null)
	// The server prop only changes on a fresh render; a successful one-click
	// enrollment must confirm immediately without waiting for revalidation.
	const [enrolledLocally, setEnrolledLocally] = React.useState(false)

	const tagMe = React.useCallback(() => {
		setError(null)
		startTransition(async () => {
			const result = await tagSubscriberAsSkills()
			if (result.success) {
				setEnrolledLocally(true)
				track('subscribed', { location, method: 'tag-me' })
			} else {
				setError(
					result.reason === 'not-subscribed'
						? 'We could not find your subscription — try the form instead.'
						: 'Something went wrong. Please try again.',
				)
			}
		})
	}, [location])

	const handleFormSuccess = React.useCallback(
		(subscriber: Subscriber | undefined) => {
			if (subscriber) {
				track('subscribed', { location })
				router.push(redirectUrlBuilder(subscriber, '/confirm'))
			}
		},
		[location, router],
	)

	const value = React.useMemo<SkillsNewsletterContextValue>(
		() => ({
			state: {
				status: enrolledLocally ? 'subscribed' : status,
				isPending,
				error,
			},
			actions: { tagMe, handleFormSuccess },
			meta: { location },
		}),
		[status, enrolledLocally, isPending, error, tagMe, handleFormSuccess, location],
	)

	return (
		<SkillsNewsletterContext value={value}>{children}</SkillsNewsletterContext>
	)
}

export function Heading({
	children,
	className,
	id = 'skills-newsletter-heading',
}: {
	children?: React.ReactNode
	className?: string
	id?: string
}) {
	return (
		<h2
			id={id}
			className={cn(
				'text-balance text-center font-sans text-xl font-medium leading-tight tracking-tight sm:text-left sm:text-2xl',
				className,
			)}
		>
			{children ?? (
				<>
					Follow my latest skill updates here. Plus, tips on getting the most
					out of agents with good old software fundamentals.
				</>
			)}
		</h2>
	)
}

export function Image({ className }: { className?: string }) {
	return (
		<div className={cn('aspect-[146/191] w-28 shrink-0 sm:w-32', className)}>
			<ThemeImage
				urls={SKILLS_NEWSLETTER_IMAGE}
				width={146}
				height={191}
				alt=""
				aria-hidden
				className="my-0 h-full w-full"
			/>
		</div>
	)
}

export function Form({
	label = 'Stay Up To Date',
	className,
}: {
	label?: string
	className?: string
}) {
	const { actions } = useSkillsNewsletter()
	return (
		<SubscribeToConvertkitForm
			formId={SKILLS_FORM_ID}
			fields={SKILLS_INTEREST_FIELDS}
			actionLabel={label}
			onSuccess={actions.handleFormSuccess}
			className={cn(
				'[&_button]:bg-foreground [&_button]:text-background [&_input]:border-foreground/15 [&_input]:bg-muted [&_input]:text-foreground [&_input]:placeholder:text-foreground/60 grid w-full grid-cols-2 gap-3 [&_button]:col-span-2 [&_button]:h-16 [&_button]:rounded-none [&_button]:border-0 [&_button]:px-8 [&_button]:text-base [&_button]:font-semibold [&_input]:h-14 [&_input]:rounded-none [&_input]:border [&_input]:px-6 [&_input]:text-base [&_label]:hidden',
				className,
			)}
		/>
	)
}

export function TagMeButton({
	className,
	label = 'Send me skill updates',
}: {
	className?: string
	label?: React.ReactNode
}) {
	const { state, actions } = useSkillsNewsletter()
	return (
		<button
			type="button"
			onClick={actions.tagMe}
			disabled={state.isPending}
			className={cn(
				'bg-foreground text-background flex h-16 w-full items-center justify-center px-8 text-base font-semibold disabled:opacity-60',
				className,
			)}
		>
			{state.isPending ? <Spinner className="h-5 w-5" /> : label}
		</button>
	)
}

/**
 * Renders the variant matching the LIVE status from context, so a successful
 * one-click enrollment flips to the subscribed confirmation immediately.
 * Server components pass the variants as pre-rendered nodes.
 */
export function StatusView({
	subscribed,
	tagMe,
	form,
}: {
	subscribed: React.ReactNode
	tagMe: React.ReactNode
	form: React.ReactNode
}) {
	const { state } = useSkillsNewsletter()
	if (state.status === 'subscribed') return <>{subscribed}</>
	if (state.status === 'tag-me') return <>{tagMe}</>
	return <>{form}</>
}

export function Privacy({
	className,
	formMessage = 'I respect your privacy. Unsubscribe at any time.',
	tagMeMessage = "You're already subscribed — one click to get on the skills list.",
}: {
	className?: string
	formMessage?: React.ReactNode
	tagMeMessage?: React.ReactNode
}) {
	const { state } = useSkillsNewsletter()

	if (state.error) {
		return (
			<p className={cn('text-destructive text-center text-xs', className)}>
				{state.error}
			</p>
		)
	}

	return (
		<p
			className={cn(
				'inline-flex items-center justify-center gap-2 text-xs opacity-60',
				className,
			)}
		>
			<ShieldCheckIcon className="h-3.5 w-3.5" />
			<span>{state.status === 'tag-me' ? tagMeMessage : formMessage}</span>
		</p>
	)
}
