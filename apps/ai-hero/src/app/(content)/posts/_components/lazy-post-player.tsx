'use client'

import dynamic from 'next/dynamic'

// The [post] page imports PostPlayer statically, and a client component
// statically imported by a route's server module is part of that route's
// chunk set whether or not it renders. PostPlayer imports the Mux player, so
// every article — most of which have no video — shipped 300KB+ gz of player.
// Behind this client boundary the chunk loads only when a post has a video.
// Server rendering is kept, so the player's HTML is unchanged.
export const PostPlayer = dynamic(() =>
	import('./post-player').then((mod) => mod.PostPlayer),
)
