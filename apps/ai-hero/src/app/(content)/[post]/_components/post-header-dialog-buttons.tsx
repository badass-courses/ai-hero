'use client'

import * as React from 'react'
import { Share } from '@/components/share'
import { SubscribeToConvertkitForm } from '@/convertkit'
import type { Subscriber } from '@/schemas/subscriber'
import { api } from '@/trpc/react'
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

const pillButtonClass = 'rounded-full border cursor-pointer'

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
					className={cn(pillButtonClass, className)}
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
	const pillButtonClass =
		'rounded-full hover:bg-foreground/90 cursor-pointer hover:text-background bg-foreground text-background'

	const [subscribed, setSubscribed] = React.useState(false)
	const [mounted, setMounted] = React.useState(false)
	const { data: subscriber, status } =
		api.ability.getCurrentSubscriberFromCookie.useQuery()

	React.useEffect(() => {
		setMounted(true)
	}, [])

	if (!mounted || status === 'pending' || subscriber || subscribed) {
		return null
	}

	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="default"
					size="sm"
					className={cn(pillButtonClass, className)}
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
							<Button type="submit" className="mt-2 w-full rounded-full">
								Subscribe
							</Button>
						}
						className="flex flex-col gap-3 [&_input]:h-10 [&_input]:rounded-full [&_input]:border [&_label]:text-sm"
					/>
				</div>
			</DialogContent>
		</Dialog>
	)
}
