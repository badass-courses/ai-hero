'use client'

import { useEffect, useState } from 'react'
import { track } from '@/utils/analytics'
import { CalendarPlus, Check, Copy, ExternalLink } from 'lucide-react'

import { Button } from '@coursebuilder/ui'

export function PromptActions({
	prompt,
	promptSlug,
	productId,
	sourceShortlink,
	humanCalendarUrl,
	watchUrl,
}: {
	prompt: string
	promptSlug: string
	productId?: string
	sourceShortlink?: string
	humanCalendarUrl?: string
	watchUrl?: string
}) {
	const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

	useEffect(() => {
		void track('agent_prompt_viewed', {
			prompt_slug: promptSlug,
			product_id: productId,
			source_shortlink: sourceShortlink,
			actor_intent: 'human_review',
		})
	}, [productId, promptSlug, sourceShortlink])

	const copyPrompt = async () => {
		try {
			await navigator.clipboard.writeText(prompt)
			setCopyState('copied')
			void track('agent_prompt_copied', {
				prompt_slug: promptSlug,
				product_id: productId,
				source_shortlink: sourceShortlink,
				actor_intent: 'handoff_to_agent',
			})
			window.setTimeout(() => setCopyState('idle'), 2500)
		} catch {
			setCopyState('failed')
		}
	}

	const trackHandoff = (event: string, actorIntent: string) => {
		void track(event, {
			prompt_slug: promptSlug,
			product_id: productId,
			source_shortlink: sourceShortlink,
			actor_intent: actorIntent,
		})
	}

	return (
		<div className="flex flex-col gap-4">
			<Button
				type="button"
				onClick={copyPrompt}
				className="h-12 w-full gap-2 rounded-md bg-accent-fill px-5 text-accent-fill-foreground sm:w-auto"
			>
				{copyState === 'copied' ? (
					<Check aria-hidden="true" className="size-4" />
				) : (
					<Copy aria-hidden="true" className="size-4" />
				)}
				{copyState === 'copied' ? 'Prompt copied' : 'Copy prompt'}
			</Button>

			<p
				className="min-h-5 text-sm text-[color:var(--ah-fg-muted)]"
				role="status"
			>
				{copyState === 'failed'
					? 'Clipboard access failed. Select the prompt text and copy it manually.'
					: 'Paste it into your coding agent or assistant.'}
			</p>

			{humanCalendarUrl ? (
				<Button
					asChild
					variant="outline"
					className="h-11 w-full gap-2 rounded-md sm:w-auto"
				>
					<a
						href={humanCalendarUrl}
						onClick={() =>
							trackHandoff('agent_prompt_calendar_handoff', 'human_direct')
						}
					>
						<CalendarPlus aria-hidden="true" className="size-4" />
						Add to calendar yourself
					</a>
				</Button>
			) : null}

			{watchUrl ? (
				<a
					href={watchUrl}
					onClick={() =>
						trackHandoff('agent_prompt_youtube_handoff', 'human_direct')
					}
					className="inline-flex items-center gap-1.5 text-sm font-medium underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground"
				>
					Set a reminder on YouTube
					<ExternalLink aria-hidden="true" className="size-3.5" />
				</a>
			) : null}
		</div>
	)
}
