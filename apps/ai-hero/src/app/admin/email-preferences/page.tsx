import { notFound } from 'next/navigation'
import {
	getEmailPreferenceSubscriber,
	getProviderEmailPreferences,
	getSearchParamValue,
	syncLocalEmailPreferencesFromProvider,
} from '@/lib/email-preferences'
import { getServerAuthSession } from '@/server/auth'
import { log, serializeError } from '@/server/logger'

type AdminEmailPreferencesPageProps = {
	searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Admin inspection view for provider-canonical email preferences.
 */
export default async function AdminEmailPreferencesPage(
	props: AdminEmailPreferencesPageProps,
) {
	const { ability, session } = await getServerAuthSession()

	if (ability.cannot('manage', 'all')) {
		notFound()
	}

	const searchParams = await props.searchParams
	const subscriberId = getSearchParamValue(searchParams.subscriberId)
	const subscriberEmail = getSearchParamValue(searchParams.email)
	const shouldSync = getSearchParamValue(searchParams.sync) === 'true'

	let result: Awaited<
		ReturnType<typeof syncLocalEmailPreferencesFromProvider>
	> | null = null
	let error: string | null = null

	if (subscriberId || subscriberEmail) {
		try {
			result = shouldSync
				? await syncLocalEmailPreferencesFromProvider({
						subscriberId,
						subscriberEmail,
						source: 'admin',
					})
				: {
						subscriber: await getEmailPreferenceSubscriber({
							subscriberId,
							subscriberEmail,
							source: 'admin',
						}),
						preferences: await getProviderEmailPreferences({
							subscriberId,
							subscriberEmail,
							source: 'admin',
						}),
					}

			await log.info('email-preferences.admin.inspect', {
				source: 'admin',
				provider: 'convertkit',
				userId: session?.user?.id,
				kitSubscriberId: subscriberId,
				hasSubscriberEmail: Boolean(subscriberEmail),
				result: 'success',
				sync: shouldSync,
			})
		} catch (caughtError) {
			error =
				caughtError instanceof Error
					? caughtError.message
					: 'Failed to inspect preferences'
			await log.error('email-preferences.admin.inspect.failed', {
				source: 'admin',
				provider: 'convertkit',
				userId: session?.user?.id,
				kitSubscriberId: subscriberId,
				hasSubscriberEmail: Boolean(subscriberEmail),
				result: 'failed',
				error: serializeError(caughtError),
			})
		}
	}

	const preferences = result?.preferences
		? Object.values(result.preferences)
		: []

	return (
		<main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-5 py-10">
			<div className="space-y-2">
				<h1 className="font-heading text-3xl font-bold">Email Preferences</h1>
				<p className="text-muted-foreground">
					Inspect Kit-canonical preference state and optionally sync the local
					CommunicationPreference mirror.
				</p>
			</div>

			<form className="grid gap-3 rounded-lg border p-4 sm:grid-cols-[1fr_1fr_auto]">
				<label className="space-y-1 text-sm">
					<span className="font-medium">Subscriber ID</span>
					<input
						name="subscriberId"
						defaultValue={subscriberId}
						className="border-input bg-background w-full rounded-md border px-3 py-2"
					/>
				</label>
				<label className="space-y-1 text-sm">
					<span className="font-medium">Email</span>
					<input
						name="email"
						defaultValue={subscriberEmail}
						className="border-input bg-background w-full rounded-md border px-3 py-2"
					/>
				</label>
				<div className="flex items-end gap-2">
					<button
						type="submit"
						className="border-border bg-background hover:bg-muted rounded-md border px-4 py-2 text-sm font-medium transition"
					>
						Inspect
					</button>
					<button
						type="submit"
						name="sync"
						value="true"
						className="border-border bg-background hover:bg-muted rounded-md border px-4 py-2 text-sm font-medium transition"
					>
						Sync
					</button>
				</div>
			</form>

			{error ? (
				<div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-300">
					{error}
				</div>
			) : null}

			{result ? (
				<section className="space-y-4">
					<div className="rounded-lg border p-4">
						<h2 className="font-heading text-lg font-semibold">Subscriber</h2>
						<dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
							<div>
								<dt className="text-muted-foreground">Kit ID</dt>
								<dd>{result.subscriber?.id ?? 'Not found'}</dd>
							</div>
							<div>
								<dt className="text-muted-foreground">Email</dt>
								<dd>{result.subscriber?.email_address ?? 'Unknown'}</dd>
							</div>
						</dl>
					</div>

					<div className="divide-border overflow-hidden rounded-lg border">
						{preferences.map((preference) => (
							<div
								key={preference.key}
								className="grid gap-2 p-4 text-sm sm:grid-cols-[1fr_auto]"
							>
								<div>
									<h3 className="font-medium">{preference.key}</h3>
									<p className="text-muted-foreground">
										Field: {preference.field}
									</p>
								</div>
								<div className="text-left sm:text-right">
									<p className="font-medium">{preference.status}</p>
									<p className="text-muted-foreground">
										Raw: {preference.rawValue ?? 'default'}
									</p>
								</div>
							</div>
						))}
					</div>
				</section>
			) : null}
		</main>
	)
}
