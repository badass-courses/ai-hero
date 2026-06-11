import { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { parseEmailPreferenceKey } from '@/coursebuilder/email-preferences'
import {
	getEmailPreferenceDefinition,
	getSearchParamValue,
	syncLocalEmailPreference,
	unsubscribeLocalEmailPreferenceByUserId,
	updateProviderEmailPreference,
	validateKitPreferenceIdentity,
} from '@/lib/email-preferences'
import { log } from '@/server/logger'

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
 * Confirms the user has been removed from email communication.
 */
const Unsubscribed = async (props: UnsubscribedProps) => {
	const searchParams = await props.searchParams
	await headers()
	const userId = getSearchParamValue(searchParams.userId)
	const subscriberId = getSearchParamValue(searchParams.ck_subscriber_id)
	const shKit = getSearchParamValue(searchParams.sh_kit)
	const preferenceKey = parseEmailPreferenceKey(
		getSearchParamValue(searchParams.preference),
	)
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

		const state = await updateProviderEmailPreference({
			subscriberId,
			preference: preferenceDefinition,
			subscribed: false,
			source: 'unsubscribe-link',
		})

		await syncLocalEmailPreference({
			email: subscriber.email_address,
			preference: preferenceDefinition,
			subscribed: state.subscribed,
			source: 'unsubscribe-link',
		})

		await log.info('email-preferences.unsubscribe', {
			source: 'unsubscribe-link',
			provider: 'convertkit',
			kitSubscriberId: subscriberId,
			shKit,
			preferenceKey,
			result: state.status,
		})
	} else {
		if (!userId) {
			redirect('/')
		}

		const result = await unsubscribeLocalEmailPreferenceByUserId({
			userId,
			preference: preferenceDefinition,
			source: 'unsubscribe-link',
		})

		if (!result) {
			redirect('/')
		}

		await log.info('email-preferences.unsubscribe', {
			source: 'unsubscribe-link',
			provider: 'local-db',
			userId: result.userId,
			preferenceKey,
			result: 'unsubscribed',
		})
	}

	return (
		<LayoutClient withContainer>
			<div className="flex min-h-[calc(100vh-96px)] flex-col p-0">
				<div className="flex grow flex-col items-center justify-center p-5 pb-16 text-center sm:pb-0">
					<div className="font-heading max-w-xl pt-4 text-3xl">
						You&apos;ve been removed from {listName} and won&apos;t receive any
						more emails.
					</div>
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
}

export default Unsubscribed
