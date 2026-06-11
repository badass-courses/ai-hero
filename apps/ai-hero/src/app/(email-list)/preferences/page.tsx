import type { Metadata } from 'next'
import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { emailPreferenceDefinitions } from '@/coursebuilder/email-preferences'
import {
	getProviderEmailPreferences,
	getSearchParamValue,
	validateKitPreferenceIdentity,
} from '@/lib/email-preferences'
import { log } from '@/server/logger'

import { updateEmailPreferenceAction } from './actions'

export const metadata: Metadata = {
	title: 'Email Preferences',
	description: 'Manage your AI Hero email preferences.',
	robots: 'noindex, nofollow',
}

type PreferencesPageProps = {
	searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Renders a no-login preference center for subscribers arriving from Kit links.
 */
export default async function PreferencesPage(props: PreferencesPageProps) {
	const searchParams = await props.searchParams
	const subscriberId = getSearchParamValue(searchParams.ck_subscriber_id)
	const shKit = getSearchParamValue(searchParams.sh_kit)
	const error = getSearchParamValue(searchParams.error)
	const updatedPreference = getSearchParamValue(searchParams.updated)
	const updatedState = getSearchParamValue(searchParams.state)

	const subscriber = await validateKitPreferenceIdentity({
		subscriberId,
		shKit,
		source: 'preferences-page',
		route: '/preferences',
	})

	const preferences = subscriber
		? await getProviderEmailPreferences({
				subscriberId,
				source: 'preferences-page',
			})
		: null

	await log.info('email-preferences.view', {
		source: 'preferences-page',
		provider: 'convertkit',
		kitSubscriberId: subscriberId,
		shKit,
		result: subscriber && preferences ? 'success' : 'failed',
	})

	return (
		<LayoutClient withContainer>
			<main className="mx-auto flex min-h-[calc(100vh-96px)] w-full max-w-2xl flex-col justify-center px-5 py-16">
				<div className="space-y-8">
					<div className="space-y-3 text-center">
						<p className="text-muted-foreground text-sm font-medium uppercase tracking-wide">
							AI Hero
						</p>
						<h1 className="font-heading text-3xl font-bold">
							Email preferences
						</h1>
						<p className="text-muted-foreground">
							Choose which updates you want. Kit is the source of truth, and we
							mirror this in AI Hero for app-originated sends.
						</p>
					</div>

					{error || !subscriber || !preferences ? (
						<div className="border-border bg-muted/30 rounded-lg border p-5 text-center">
							<h2 className="font-heading text-xl font-semibold">
								This preference link is missing or expired
							</h2>
							<p className="text-muted-foreground mt-2 text-sm">
								Open the preference link from a recent AI Hero email so we can
								verify your subscriber record without requiring a login.
							</p>
							<Link
								href="/"
								className="text-primary mt-4 inline-flex text-sm font-medium hover:underline"
							>
								Back to AI Hero
							</Link>
						</div>
					) : (
						<div className="space-y-4">
							{updatedPreference && updatedState ? (
								<div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300">
									Updated {updatedPreference} to {updatedState}.
								</div>
							) : null}

							<div className="divide-border overflow-hidden rounded-lg border">
								{emailPreferenceDefinitions.map((preference) => {
									const state = preferences[preference.key]
									const subscribed =
										state?.subscribed ?? preference.defaultSubscribed

									return (
										<div
											key={preference.key}
											className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
										>
											<div className="space-y-1">
												<h2 className="font-heading text-lg font-semibold">
													{preference.name}
												</h2>
												<p className="text-muted-foreground text-sm">
													{preference.description}
												</p>
												<p className="text-muted-foreground text-xs">
													Current: {subscribed ? 'subscribed' : 'unsubscribed'}
												</p>
											</div>
											<form action={updateEmailPreferenceAction}>
												<input
													type="hidden"
													name="ck_subscriber_id"
													value={subscriberId}
												/>
												<input type="hidden" name="sh_kit" value={shKit} />
												<input
													type="hidden"
													name="preference"
													value={preference.key}
												/>
												<input
													type="hidden"
													name="subscribed"
													value={subscribed ? 'false' : 'true'}
												/>
												<button
													type="submit"
													className="border-border bg-background hover:bg-muted rounded-md border px-4 py-2 text-sm font-medium transition"
												>
													{subscribed ? 'Opt out' : 'Opt in'}
												</button>
											</form>
										</div>
									)
								})}
							</div>
						</div>
					)}
				</div>
			</main>
		</LayoutClient>
	)
}
