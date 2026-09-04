'use client'

import * as React from 'react'
import { useMuxPlayer } from '@/hooks/use-mux-player'
import { api } from '@/trpc/react'
import { useSession } from 'next-auth/react'

/**
 * Overlay the account-level 480p flag from UserPrefs onto the cookie cache.
 * Volume and rate stay device-local. Must render under Session, MuxPlayer, and tRPC.
 */
export function PlaybackPrefHydrator() {
	const { status } = useSession()
	const { setPlayerPrefs } = useMuxPlayer()
	const { data } = api.users.getPlaybackPrefs.useQuery(undefined, {
		enabled: status === 'authenticated',
	})

	React.useEffect(() => {
		if (!data?.stored) return
		setPlayerPrefs({ allowLowResolution: data.allowLowResolution })
	}, [data, setPlayerPrefs])

	return null
}
