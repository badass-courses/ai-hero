'use client'

import dynamic from 'next/dynamic'

// A server-side dynamic import does not split a client component's dependencies.
// Keep this boundary in a client module so non-video MDX pages don't load Mux.
const LazyMDXVideo = dynamic(() => import('./mdx-video'), { ssr: false })

export default LazyMDXVideo
