'use client'

import dynamic from 'next/dynamic'

// hero.tsx is a server component, so importing HeroVideo directly puts the Mux
// player in the homepage's client JS even when no hero video is configured.
// Keep this boundary in a client module so the player loads only when rendered.
export const HeroVideo = dynamic(() =>
	import('./hero-video').then((mod) => mod.HeroVideo),
)
