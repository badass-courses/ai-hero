'use client'

import { useRouter } from 'next/navigation'
import { useSocket } from '@/hooks/use-socket'
import { useSession } from 'next-auth/react'

/**
 * Live CMS updates: when a video asset or transcript lands, refresh the
 * route so the editor looking at it sees it without reloading.
 *
 * Signed-in readers only. This used to open a PartyKit socket for every
 * visitor on every page, and then call `router.refresh()` for all of them
 * on each CMS event — one upload re-fetched the current route for everyone
 * on the site at that moment. Anonymous readers have nothing to refresh for.
 */
export function Party({ room }: { room?: string }) {
	const { status } = useSession()
	if (status !== 'authenticated') return null
	return <PartySocket room={room} />
}

function PartySocket({ room }: { room?: string }) {
	const router = useRouter()
	useSocket({
		room,
		onMessage: async (messageEvent) => {
			try {
				const data = JSON.parse(messageEvent.data)
				const invalidateOn = [
					'videoResource.created',
					'video.asset.ready',
					'transcript.ready',
					'ai.tip.draft.completed',
					'video.asset.detached',
					'video.asset.attached',
				]

				if (invalidateOn.includes(data.name)) {
					router.refresh()
				}
			} catch (error) {
				// noting to do
			}
		},
	})

	return null
}
