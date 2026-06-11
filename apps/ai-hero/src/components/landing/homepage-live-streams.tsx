import * as React from 'react'
import {
	getHomepageYouTubeLiveBroadcasts,
	type PublicYouTubeLiveBroadcast,
} from '@/lib/youtube-live-schedule'
import { ArrowUpRight, Radio } from 'lucide-react'

const previewBroadcasts = {
	active: [
		{
			id: 'preview-live-now',
			title: 'Building Production AI Apps with Matt Pocock',
			description: 'Local preview broadcast.',
			scheduledStartTime: new Date().toISOString(),
			scheduledEndTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			actualStartTime: new Date().toISOString(),
			actualEndTime: null,
			lifeCycleStatus: 'live',
			privacyStatus: 'public',
			status: 'live',
			watchUrl: 'https://www.youtube.com/@mattpocockuk',
		},
	],
} satisfies {
	active: PublicYouTubeLiveBroadcast[]
}

function LiveNowBanner({
	broadcast,
}: {
	broadcast: PublicYouTubeLiveBroadcast
}) {
	return (
		<a
			href={broadcast.watchUrl}
			target="_blank"
			rel="noreferrer"
			className="bg-primary text-primary-foreground flex flex-col gap-3 px-5 py-3 transition-[filter] hover:brightness-110 sm:flex-row sm:items-center sm:justify-between sm:px-6"
		>
			<div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
				<div className="flex flex-wrap items-center gap-3">
					<span className="bg-primary-foreground text-primary inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider">
						<Radio className="size-3" aria-hidden />
						Live now
					</span>
				</div>
				<div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
					<h2 className="truncate text-base font-semibold leading-tight tracking-tight sm:text-lg">
						{broadcast.title}
					</h2>
					<span className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-70">
						YouTube
					</span>
				</div>
			</div>
			<span className="inline-flex shrink-0 items-center gap-2 text-sm font-medium">
				Watch
				<ArrowUpRight className="size-4" aria-hidden />
			</span>
		</a>
	)
}

export async function HomepageLiveStreams({
	preview = false,
}: {
	preview?: boolean
}) {
	const { active } = preview
		? previewBroadcasts
		: await getHomepageYouTubeLiveBroadcasts()
	const liveBroadcast = active[0]

	if (!liveBroadcast) {
		return null
	}

	return (
		<section className="border-border border-b">
			<LiveNowBanner broadcast={liveBroadcast} />
		</section>
	)
}
