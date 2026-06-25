'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { redirectUrlBuilder, SubscribeToConvertkitForm } from '@/convertkit'
import { type Subscriber } from '@/schemas/subscriber'
import { api } from '@/trpc/react'
import { track } from '@/utils/analytics'
import { CheckCircle, ShieldCheck } from 'lucide-react'

import { GRADIENT_IMAGE } from '@/components/resource-hover-frame'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import {
	addWorkshopInterest,
	tagWorkshopInterestByEmail,
} from './workshop-interest-actions'
import { workshopInterestFieldKey } from './workshop-interest-config'

/**
 * Pre-launch interest capture shown in the workshop sidebar while a workshop is
 * not yet published. New visitors subscribe via the ConvertKit form (carrying a
 * per-workshop custom field); people already on the list get a one-click button.
 */
export const WorkshopInterestCta = ({
	workshopSlug,
	workshopTitle,
	className,
}: {
	workshopSlug: string
	workshopTitle?: string
	className?: string
}) => {
	const router = useRouter()
	const { data: subscriber, status } =
		api.ability.getCurrentSubscriberFromCookie.useQuery()
	const [isPending, startTransition] = React.useTransition()
	const [done, setDone] = React.useState(false)
	const [error, setError] = React.useState(false)

	const fieldKey = workshopInterestFieldKey(workshopSlug)
	const today = new Date().toISOString().slice(0, 10)

	// They already expressed interest in this specific workshop on a prior visit.
	const alreadyInterested = Boolean(subscriber?.fields?.[fieldKey])

	const handleFormSuccess = async (sub?: Subscriber) => {
		if (sub) {
			track('subscribed', {
				location: 'workshop_interest',
				workshop: workshopSlug,
			})
			// The form sets the per-workshop field but can't apply a tag, so tag
			// the new subscriber here for parity with the one-click path.
			if (sub.email_address) {
				await tagWorkshopInterestByEmail(sub.email_address, workshopSlug)
			}
			router.push(redirectUrlBuilder(sub, '/confirm'))
		}
	}

	const handleKnownSubscriberClick = () => {
		setError(false)
		startTransition(async () => {
			const result = await addWorkshopInterest(workshopSlug)
			if (result.success) {
				track('subscribed', {
					location: 'workshop_interest_existing',
					workshop: workshopSlug,
				})
				setDone(true)
			} else {
				setError(true)
			}
		})
	}

	return (
		<div
			className={cn('animate-resource-gradient p-[2px]', className)}
			style={{
				backgroundImage: GRADIENT_IMAGE,
				backgroundSize: '200% 200%',
			}}
		>
			<div className="bg-card flex flex-col gap-4 px-5 py-6">
			<div className="flex flex-col gap-1.5">
				<h3 className="text-xl font-semibold tracking-tight">
					Be first in line
				</h3>
				<p className="text-muted-foreground text-sm leading-relaxed">
					{`${workshopTitle ?? 'This workshop'} is on the way. Leave your email and we’ll let you know the moment it’s live.`}
				</p>
			</div>

			{done || alreadyInterested ? (
				<p className="text-primary flex items-start gap-2 text-balance text-sm font-medium">
					<CheckCircle className="mt-0.5 h-4 w-4 shrink-0" /> You&rsquo;re on the
					list. We&rsquo;ll email you the moment it&rsquo;s live.
				</p>
			) : status === 'pending' ? (
				<div className="flex flex-col gap-3">
					<div className="bg-muted h-12 w-full animate-pulse rounded-none" />
					<div className="bg-muted h-12 w-full animate-pulse rounded-none" />
					<div className="bg-muted mt-1 h-12 w-full animate-pulse rounded-none" />
				</div>
			) : subscriber ? (
				<div className="flex flex-col gap-2">
					<Button
						onClick={handleKnownSubscriberClick}
						disabled={isPending}
						size="lg"
						className="h-12 w-full rounded-none"
					>
						{isPending ? 'Adding you…' : 'Keep me posted'}
					</Button>
					{error && (
						<p className="text-destructive text-sm">
							Something went wrong. Please try again.
						</p>
					)}
				</div>
			) : (
				<>
					<SubscribeToConvertkitForm
						actionLabel="Notify me"
						fields={{ [fieldKey]: today }}
						onSuccess={handleFormSuccess}
						className="flex flex-col gap-3 [&_button]:mt-1 [&_button]:h-12 [&_button]:w-full [&_input]:h-12 [&_input]:rounded-none [&_label]:text-sm"
					/>
					<p className="text-muted-foreground inline-flex items-center text-xs">
						<ShieldCheck className="mr-1.5 h-3.5 w-3.5" /> No spam. Unsubscribe
						anytime.
					</p>
				</>
			)}
			</div>
		</div>
	)
}
