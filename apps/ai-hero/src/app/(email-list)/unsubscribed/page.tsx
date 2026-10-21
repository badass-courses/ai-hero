import { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { resolveUnsubscribePreference } from '@/coursebuilder/email-preferences'
import {
	getEmailPreferenceDefinition,
	getSearchParamValue,
	validateKitPreferenceIdentity,
} from '@/lib/email-preferences'
import { log } from '@/server/logger'

import { UnsubscribeForm } from './unsubscribe-form'

export const metadata: Metadata = {
	title: 'Unsubscribed',
	description: 'Unsubscribed',
	robots: 'noindex, nofollow',
}

type UnsubscribedProps = {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

/**
 * Returns the display name for the list the user unsubscribed from.
 */
const getListName = (
	searchParams: Awaited<UnsubscribedProps['searchParams']>,
) => {
	const listName = searchParams.listName ?? searchParams.list
	const normalizedListName = Array.isArray(listName) ? listName[0] : listName

	return normalizedListName?.trim() || 'the email list'
}

/**
 * Asks the user to confirm leaving a list. Writes nothing on GET.
 */
const Unsubscribed = async (props: UnsubscribedProps) => {
	const searchParams = await props.searchParams
	await headers()
	const resolution = resolveUnsubscribePreference(
		getSearchParamValue(searchParams.preference),
	)
	if (resolution.kind === 'cohort-updates') {
		return (
			<UnsubscribedMessage message="You've been removed from AI Hero cohort updates. You'll still get other AI Hero emails." />
		)
	}
	const userId = getSearchParamValue(searchParams.userId)
	const subscriberId = getSearchParamValue(searchParams.ck_subscriber_id)
	const shKit = getSearchParamValue(searchParams.sh_kit)
	if (resolution.kind === 'unknown') {
		// A typo or stale link must never fall back to the newsletter all-stop.
		await log.warn('email-preferences.unknown_preference', {
			source: 'unsubscribe-link',
			preference: resolution.raw.slice(0, 100),
			hasKitIdentity: Boolean(subscriberId && shKit),
		})
		return (
			<UnsubscribedMessage
				message="Choose which emails you want to stop."
				managePreferencesHref={
					subscriberId && shKit
						? `/preferences?${new URLSearchParams({
								ck_subscriber_id: subscriberId,
								sh_kit: shKit,
							}).toString()}`
						: '/preferences'
				}
			/>
		)
	}
	const preferenceKey = resolution.key
	const preferenceDefinition = getEmailPreferenceDefinition(preferenceKey)
	const listName =
		getListName(searchParams) === 'the email list'
			? preferenceDefinition.name
			: getListName(searchParams)
	const managePreferencesHref =
		subscriberId && shKit
			? `/preferences?${new URLSearchParams({
					ck_subscriber_id: subscriberId,
					sh_kit: shKit,
				}).toString()}`
			: '/preferences'

	// GET only validates. The writes happen in unsubscribeAction on POST, so a
	// link scanner or bot that opens this URL unsubscribes nobody.
	if (subscriberId && shKit) {
		const subscriber = await validateKitPreferenceIdentity({
			subscriberId,
			shKit,
			source: 'unsubscribe-link',
			route: '/unsubscribed',
		})

		if (!subscriber) {
			redirect('/')
		}
	} else if (!userId) {
		redirect('/')
	}

	const hiddenFields: Record<string, string> = { preference: preferenceKey }
	if (subscriberId && shKit) {
		hiddenFields.ck_subscriber_id = subscriberId
		hiddenFields.sh_kit = shKit
	} else if (userId) {
		hiddenFields.userId = userId
	}

	return (
		<LayoutClient withContainer>
			<div className="flex min-h-[calc(100vh-96px)] flex-col p-0">
				<div className="flex grow flex-col items-center justify-center p-5 pb-16 text-center sm:pb-0">
					<UnsubscribeForm
						listName={listName}
						hiddenFields={hiddenFields}
						managePreferencesHref={managePreferencesHref}
					/>
				</div>
			</div>
		</LayoutClient>
	)
}

const UnsubscribedMessage = ({
	message,
	managePreferencesHref = '/preferences',
}: {
	message: string
	managePreferencesHref?: string
}) => (
	<LayoutClient withContainer>
		<div className="flex min-h-[calc(100vh-96px)] flex-col p-0">
			<div className="flex grow flex-col items-center justify-center p-5 pb-16 text-center sm:pb-0">
				<div className="font-heading max-w-xl pt-4 text-3xl">{message}</div>
				<Link
					href={managePreferencesHref}
					className="text-primary mt-6 text-sm font-medium hover:underline"
				>
					Manage all email preferences
				</Link>
			</div>
		</div>
	</LayoutClient>
)

export default Unsubscribed
