import { type Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PromptActions } from '@/components/prompts/prompt-actions'
import { TYPE } from '@/components/landing/type'
import { getDiscoveryBaseUrl } from '@/lib/agent-discovery'
import { isPromptPubliclyViewable } from '@/lib/prompts'
import { getPrompt, getPromptProductIds } from '@/lib/prompts-query'
import { getServerAuthSession } from '@/server/auth'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'

import { Button } from '@coursebuilder/ui'

export const revalidate = 300

type Props = {
	params: Promise<{ slug: string }>
	searchParams: Promise<Record<string, string | string[] | undefined>>
}

function firstSearchParam(value: string | string[] | undefined) {
	return Array.isArray(value) ? value[0] : value
}

function promptApiUrl(
	slug: string,
	params?: {
		source?: string
		subscriberId?: string
		shKit?: string
	},
) {
	const url = new URL(`/api/prompts/${slug}`, getDiscoveryBaseUrl())
	if (params?.source) url.searchParams.set('source', params.source)
	if (params?.subscriberId && /^\d{1,20}$/.test(params.subscriberId)) {
		url.searchParams.set('ck_subscriber_id', params.subscriberId)
	}
	if (params?.shKit && /^[a-f0-9]{64}$/i.test(params.shKit)) {
		url.searchParams.set('sh_kit', params.shKit)
	}
	return url.toString()
}

function formatEventTime(startsAt: string, endsAt: string, timezone: string) {
	const date = new Date(startsAt)
	const end = new Date(endsAt)
	const dateFormatter = new Intl.DateTimeFormat('en-GB', {
		weekday: 'long',
		day: 'numeric',
		month: 'long',
		year: 'numeric',
		timeZone: timezone,
	})
	const timeFormatter = new Intl.DateTimeFormat('en-GB', {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: timezone,
		timeZoneName: 'short',
	})

	return `${dateFormatter.format(date)}, ${timeFormatter.format(date)} to ${timeFormatter.format(end)}`
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
	const { slug } = await params
	const prompt = await getPrompt(slug)

	if (!prompt || !isPromptPubliclyViewable(prompt)) {
		return { title: 'Prompt not found' }
	}

	const apiUrl = promptApiUrl(prompt.fields.slug)

	return {
		title: prompt.fields.title,
		description: prompt.fields.description ?? undefined,
		robots:
			prompt.fields.visibility === 'unlisted'
				? { index: false, follow: false }
				: undefined,
		alternates: {
			canonical: `/prompts/${prompt.fields.slug}`,
			types: { 'application/json': apiUrl },
		},
		openGraph: { images: [getOGImageUrlForResource(prompt)] },
	}
}

export default async function PromptPage({ params, searchParams }: Props) {
	const [{ slug }, query] = await Promise.all([params, searchParams])
	const prompt = await getPrompt(slug)

	if (!prompt) notFound()

	let canEdit = false
	if (!isPromptPubliclyViewable(prompt)) {
		const { session, ability } = await getServerAuthSession()
		if (!session?.user || !ability.can('update', 'Content')) notFound()
		canEdit = true
	}

	const productIds = await getPromptProductIds(prompt.id)
	const productId = productIds.at(0)
	const event = prompt.fields.event
	const promptBody = prompt.fields.body?.trim()
	const sourceCandidate = firstSearchParam(query.source)
	const sourceShortlink =
		sourceCandidate && /^[a-z0-9_-]{1,80}$/i.test(sourceCandidate)
			? sourceCandidate
			: 'uncle-bob-prompt'
	const subscriberId = firstSearchParam(query.ck_subscriber_id)
	const shKit = firstSearchParam(query.sh_kit)
	const apiUrl = promptApiUrl(prompt.fields.slug, {
		source: sourceShortlink,
		subscriberId,
		shKit,
	})

	if (!promptBody) notFound()

	const promptText = [
		promptBody,
		'',
		'Read the verified event context and AGENT INSTRUCTIONS here:',
		apiUrl,
		'',
		'Kit subscriber context grants essential read-only context only. If account authorization is needed, use the single device-flow command returned by that endpoint. Never put an access token in a URL or chat message.',
	].join('\n')

	return (
		<main>
			<section className="border-b border-border">
				<div className="px-[18px] py-12 sm:px-11 md:py-[52px]">
					<div className="mx-auto flex max-w-4xl flex-col gap-5">
						<div className="flex items-center justify-between gap-4">
							<p className={TYPE.eyebrow}>AGENT PROMPT</p>
							{canEdit ? (
								<Button asChild size="sm" variant="outline">
									<Link href={`/prompts/${prompt.fields.slug}/edit`}>Edit</Link>
								</Button>
							) : null}
						</div>
						<h1 className={TYPE.title}>{prompt.fields.title}</h1>
						{prompt.fields.description ? (
							<p className={`${TYPE.lead} max-w-2xl text-[color:var(--ah-fg-body)]`}>
								{prompt.fields.description}
							</p>
						) : null}
					</div>
				</div>
			</section>

			<section className="border-b border-border">
				<div className="px-[18px] py-12 sm:px-11 md:py-[52px]">
					<div className="mx-auto grid max-w-4xl gap-8 md:grid-cols-[minmax(0,1.4fr)_minmax(240px,0.6fr)] md:gap-16">
						<div className="flex min-w-0 flex-col gap-5">
							<h2 className={TYPE.subhead}>Copy this into your agent</h2>
							<pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-input bg-card p-5 font-mono text-sm leading-relaxed text-card-foreground [overflow-wrap:anywhere]">
								<code>{promptText}</code>
							</pre>
							<PromptActions
								prompt={promptText}
								promptSlug={prompt.fields.slug}
								productId={productId}
								sourceShortlink={sourceShortlink}
								humanCalendarUrl={event?.humanCalendarUrl}
								watchUrl={event?.watchUrl}
							/>
						</div>

						<aside className="flex flex-col gap-6 border-t border-[color:var(--ah-line-soft)] pt-6 md:border-l md:border-t-0 md:pl-8 md:pt-0">
							{event ? (
								<div className="flex flex-col gap-2">
									<p className={TYPE.groupLabel}>Livestream</p>
									<h2 className={TYPE.cardTitle}>{event.title}</h2>
									<time
										dateTime={event.startsAt}
										className="text-sm text-[color:var(--ah-fg-muted)]"
									>
										{formatEventTime(event.startsAt, event.endsAt, event.timezone)}
									</time>
								</div>
							) : null}

							<div className="flex flex-col gap-2 border-t border-[color:var(--ah-line-soft)] pt-5">
								<p className={TYPE.groupLabel}>For agents</p>
								<p className="text-sm leading-relaxed text-[color:var(--ah-fg-muted)]">
									Read the canonical JSON or Markdown response for event facts, actions,
									and agent instructions.
								</p>
								<a
									href={apiUrl}
									className="font-mono text-xs underline decoration-foreground/30 underline-offset-4 [overflow-wrap:anywhere] hover:decoration-foreground"
								>
									{apiUrl}
								</a>
							</div>
						</aside>
					</div>
				</div>
			</section>
		</main>
	)
}
