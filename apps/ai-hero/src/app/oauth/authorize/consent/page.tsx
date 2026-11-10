import * as React from 'react'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { openConsentTicket } from '@/lib/learner-agent/oauth/codes'
import { redirectDisplay } from '@/lib/learner-agent/oauth/redirect-uri'
import { getServerAuthSession } from '@/server/auth'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { CONSENT_COPY, consentErrorMessage } from './copy'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
	title: CONSENT_COPY.metaTitle,
	robots: { index: false, follow: false },
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<LayoutClient withContainer>
			<main className="flex grow flex-col">
				<section className="border-b">
					<div className="mx-auto w-full max-w-xl px-[18px] py-12 sm:px-11 md:py-[52px]">
						{children}
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}

function ErrorView({ reason }: { reason: string }) {
	return (
		<Shell>
			<h1 className={TYPE.heading}>{CONSENT_COPY.errorTitle}</h1>
			<p className={cn(TYPE.lead, 'text-muted-foreground mt-4')}>
				{consentErrorMessage(reason)}
			</p>
		</Shell>
	)
}

/**
 * The OAuth consent page. It renders only a sealed ticket from
 * `/oauth/authorize`, so every value shown was validated there, and posts
 * the learner's decision to `/oauth/authorize/decision`.
 */
export default async function ConsentPage(props: {
	searchParams: Promise<{ ticket?: string; error?: string }>
}) {
	const { ticket, error } = await props.searchParams
	if (error || !ticket) return <ErrorView reason={error ?? 'missing'} />

	const opened = openConsentTicket(ticket)
	if (!opened) return <ErrorView reason="expired" />

	const { session } = await getServerAuthSession()
	if (!session?.user?.id) {
		redirect(
			`/login?callbackUrl=${encodeURIComponent(`/oauth/authorize/consent?ticket=${ticket}`)}`,
		)
	}
	if (session.user.id !== opened.userId)
		return <ErrorView reason="wrong_account" />

	const { request } = opened
	const destination = redirectDisplay(request.redirectUri)

	return (
		<Shell>
			<h1 className={TYPE.heading}>{CONSENT_COPY.title(request.clientName)}</h1>
			<p className={cn(TYPE.lead, 'text-muted-foreground mt-4')}>
				{CONSENT_COPY.scopeLine(request.clientName)}
			</p>

			<dl className="border-input bg-card mt-8 rounded-[9px] border">
				<div className="px-5 py-4">
					<dt className={cn(TYPE.metaSm, 'text-muted-foreground')}>
						{CONSENT_COPY.redirectLabel}
					</dt>
					<dd className={cn(TYPE.subhead, 'mt-1 break-all')}>
						{destination.host}
					</dd>
					{destination.loopback ? (
						<p className={cn(TYPE.meta, 'text-foreground mt-3')}>
							{CONSENT_COPY.loopbackWarning}
						</p>
					) : null}
				</div>
				{session.user.email ? (
					<div className="border-t border-[color:var(--ah-line-soft)] px-5 py-4">
						<dt className={cn(TYPE.metaSm, 'text-muted-foreground')}>
							{CONSENT_COPY.accountLabel}
						</dt>
						<dd className={cn(TYPE.meta, 'mt-1 break-all')}>
							{session.user.email}
						</dd>
					</div>
				) : null}
			</dl>

			<p className={cn(TYPE.metaSm, 'text-muted-foreground mt-4')}>
				{CONSENT_COPY.lifetime}
			</p>

			<form
				method="post"
				action="/oauth/authorize/decision"
				className="mt-8 flex flex-wrap gap-3"
			>
				<input type="hidden" name="ticket" value={ticket} />
				<Button
					type="submit"
					name="decision"
					value="approve"
					className="focus-visible:ring-ring font-semibold focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					{CONSENT_COPY.approve}
				</Button>
				<Button
					type="submit"
					name="decision"
					value="deny"
					variant="outline"
					className="focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2"
				>
					{CONSENT_COPY.deny}
				</Button>
			</form>
		</Shell>
	)
}
