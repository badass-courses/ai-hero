'use client'

import * as React from 'react'
import { Share } from '@/components/share'
import { SubscribeToConvertkitForm } from '@/convertkit'
import { useCtaGate } from '@/hooks/use-cta-gate'
import { isOnEmailList } from '@/lib/cta-gating'
import type { Subscriber } from '@/schemas/subscriber'
import { track } from '@/utils/analytics'
import { MailPlus, Share2 } from 'lucide-react'

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

/** The shared treatment for every action in the post head: a hairline-outlined
 *  ghost at the 9px button radius (DESIGN rule 12 — `rounded-full` is for
 *  circles). */
const headActionClass = 'cursor-pointer rounded-[9px] border'

export function PostShareDialogButton({
	title,
	className,
}: {
	title?: string
	className?: string
}) {
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="default"
					className={cn(headActionClass, className)}
				>
					<Share2 className="size-4" aria-hidden="true" />
					Share
				</Button>
			</DialogTrigger>
			<DialogContent
				lockScroll={false}
				className="max-w-[min(640px,calc(100vw-2rem))] gap-0 overflow-hidden rounded-2xl p-0"
			>
				<DialogTitle className="border-b px-6 py-5 text-xl">Share</DialogTitle>
				<Share variant="dialog" title={title} className="p-6" />
			</DialogContent>
		</Dialog>
	)
}

export function PostSubscribeDialogButton({
	postSlug,
	className,
}: {
	postSlug?: string
	className?: string
}) {
	const [subscribed, setSubscribed] = React.useState(false)
	const { subscriber } = useCtaGate()

	// The resolved answer, and nothing else. Waiting for a mount effect and for
	// the query to settle meant this button was absent from the head action row
	// on first paint and inserted itself into it a moment later — shifting Copy
	// page, Share and Source Code sideways under the reader's cursor, on every
	// article, for everyone who was not already subscribed.
	if (subscribed || isOnEmailList(subscriber)) {
		return null
	}

	return (
		<Dialog>
			<DialogTrigger asChild>
				{/* Same treatment as the other head actions (Copy page, Share, Source
				    Code): a hairline-outlined ghost at the 9px button radius. It was a
				    filled `rounded-full` pill, which made it the only pill and the only
				    solid fill in a row of outlined chips. */}
				<Button
					type="button"
					variant="ghost"
					size="default"
					className={cn(headActionClass, className)}
				>
					{/* <MailPlus className="size-4" aria-hidden="true" /> */}
					Subscribe
				</Button>
			</DialogTrigger>
			<DialogContent lockScroll={false} className="max-w-md">
				<DialogTitle>Subscribe</DialogTitle>
				<DialogDescription>
					Get new AI Hero lessons and updates by email.
				</DialogDescription>
				<div className="pt-2">
					<SubscribeToConvertkitForm
						id="post-header-subscribe"
						actionLabel="Subscribe"
						successMessage={<p className="text-sm">Thanks, you're in.</p>}
						onSuccess={(newSubscriber: Subscriber | undefined) => {
							if (newSubscriber) {
								void track('subscribed', {
									post: postSlug ?? '',
									location: 'post-header',
								})
								setSubscribed(true)
							}
						}}
						submitButtonElem={
							<Button type="submit" className="mt-2 w-full rounded-[9px]">
								Subscribe
							</Button>
						}
						className="flex flex-col gap-3 [&_input]:h-12 desk:[&_input]:h-10 [&_input]:rounded-[9px] [&_input]:border [&_label]:text-sm"
					/>
				</div>
			</DialogContent>
		</Dialog>
	)
}
