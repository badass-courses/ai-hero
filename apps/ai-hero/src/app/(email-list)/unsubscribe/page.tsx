import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import LayoutClient from '@/components/layout-client'
import { env } from '@/env.mjs'
import { getSearchParamValue } from '@/lib/email-preferences'
import {
	parseUnsubscribeChoice,
	readUnsubscribeState,
	resolveDrovrApiBaseUrl,
	unsubscribePageView,
	type UnsubscribeChoice,
	type UnsubscribeLookup,
} from '@/lib/subscriber-marketing/drovr-unsubscribe-page'
import { log } from '@/server/logger'

import { unsubscribeAction } from './actions'

export const metadata: Metadata = {
	title: 'Unsubscribe',
	description: 'Unsubscribe from AI Hero email.',
	robots: 'noindex, nofollow',
}

type UnsubscribePageProps = {
	searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * The unsubscribe page drovr's email footers link to. drovr answers who the
 * token belongs to and what they still get; this page shows it and posts
 * the choice back. Opening the page changes nothing: one button press does.
 */
export default async function UnsubscribePage(props: UnsubscribePageProps) {
	const searchParams = await props.searchParams
	const token = getSearchParamValue(searchParams.t)
	const choice = parseUnsubscribeChoice(getSearchParamValue(searchParams.choice))
	const updated = parseUnsubscribeChoice(
		getSearchParamValue(searchParams.updated),
	)
	const error = getSearchParamValue(searchParams.error)

	const lookup: UnsubscribeLookup =
		error === 'invalid'
			? { status: 'invalid-token' }
			: await readUnsubscribeState(token, {
					baseUrl: resolveDrovrApiBaseUrl(env),
				})

	await log.info('unsubscribe-page.view', {
		result: lookup.status,
		preselected: choice,
		updated,
		...(lookup.status === 'unavailable' ? { reason: lookup.reason } : {}),
	})

	const view = unsubscribePageView(lookup, {
		choice,
		updated,
		submitFailed: error === 'unavailable',
	})
	const supportEmail = env.NEXT_PUBLIC_SUPPORT_EMAIL

	return (
		<LayoutClient withContainer>
			<main className="mx-auto flex min-h-[calc(100vh-96px)] w-full max-w-xl flex-col justify-center px-5 py-16">
				{view.kind === 'invalid' ? (
					<Notice title="This link isn't valid">
						It may be incomplete or copied wrong. Email{' '}
						<SupportLink email={supportEmail} />{' '}
						and we&apos;ll unsubscribe you.
					</Notice>
				) : view.kind === 'unavailable' ? (
					<Notice title="We can't load your email settings right now">
						Try again in a few minutes, or email{' '}
						<SupportLink email={supportEmail} />{' '}
						and we&apos;ll unsubscribe you.
					</Notice>
				) : view.kind === 'all-unsubscribed' ? (
					<div className="space-y-3 text-center">
						<Eyebrow email={view.email} />
						<h1 className="font-heading text-3xl font-bold">
							You&apos;re unsubscribed from all AI Hero email
						</h1>
						<p
							className="text-muted-foreground"
							role={view.justUpdated ? 'status' : undefined}
						>
							{view.justUpdated
								? 'Done. You won’t get any more emails from us.'
								: 'There’s nothing else to do here.'}
						</p>
					</div>
				) : (
					<div className="space-y-8">
						<div className="space-y-3 text-center">
							<Eyebrow email={view.email} />
							<h1 className="font-heading text-3xl font-bold">Unsubscribe</h1>
							{view.justUpdated ? (
								<p
									role="status"
									className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300"
								>
									Done. You won&apos;t get any more emails from{' '}
									{view.courseName}.
								</p>
							) : view.courseUnsubscribed ? (
								<p className="text-muted-foreground">
									You&apos;re already unsubscribed from {view.courseName}.
								</p>
							) : null}
							{view.submitFailed ? (
								<p
									role="alert"
									className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300"
								>
									That didn&apos;t go through. Please try again, or email{' '}
									<SupportLink email={supportEmail} />.
								</p>
							) : null}
						</div>
						<ul className="space-y-3">
							{view.options.map((option, index) => (
								<li key={option}>
									<ChoiceForm
										token={token ?? ''}
										choice={option}
										courseName={view.courseName}
										courseOff={view.courseUnsubscribed}
										primary={index === 0}
									/>
								</li>
							))}
						</ul>
					</div>
				)}
			</main>
		</LayoutClient>
	)
}

function ChoiceForm({
	token,
	choice,
	courseName,
	courseOff,
	primary,
}: {
	token: string
	choice: UnsubscribeChoice
	courseName: string
	courseOff: boolean
	primary: boolean
}) {
	const label =
		choice === 'course'
			? `Unsubscribe from ${courseName}`
			: 'Unsubscribe from all AI Hero email'
	const detail =
		choice === 'course'
			? 'Stops this course’s emails. Other AI Hero email still arrives.'
			: courseOff
				? 'Stops every email from AI Hero.'
				: 'Stops every email from AI Hero, including this course.'
	return (
		<form action={unsubscribeAction} className="space-y-1">
			<input type="hidden" name="t" value={token} />
			<input type="hidden" name="choice" value={choice} />
			<button
				type="submit"
				className={
					primary
						? 'bg-primary text-primary-foreground focus-visible:ring-ring w-full rounded-md px-4 py-3 text-base font-semibold transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'
						: 'border-border bg-background hover:bg-muted focus-visible:ring-ring w-full rounded-md border px-4 py-3 text-base font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2'
				}
			>
				{label}
			</button>
			<p className="text-muted-foreground text-center text-sm">{detail}</p>
		</form>
	)
}

function Eyebrow({ email }: { email: string }) {
	return (
		<p className="text-muted-foreground text-sm">
			AI Hero email for <span className="font-medium">{email}</span>
		</p>
	)
}

function Notice({
	title,
	children,
}: {
	title: string
	children: ReactNode
}) {
	return (
		<div className="space-y-3 text-center">
			<h1 className="font-heading text-2xl font-bold">{title}</h1>
			<p className="text-muted-foreground">{children}</p>
		</div>
	)
}

function SupportLink({ email }: { email: string }) {
	return (
		<a
			href={`mailto:${email}?subject=${encodeURIComponent('Unsubscribe')}`}
			className="text-primary font-medium underline underline-offset-2"
		>
			{email}
		</a>
	)
}
