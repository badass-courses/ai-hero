'use client'

import dynamic from 'next/dynamic'

/**
 * Client MDX components, each behind its own lazy boundary.
 *
 * `compile-mdx.tsx` is a server module, and a `dynamic()` there does not
 * split a client component's dependencies: every page that compiles MDX —
 * the homepage included — shipped Dexie (the checkbox), react-markdown (the
 * commit map), the page-builder widgets and the rest whether or not the
 * body used them. The boundary has to live in a client module (same reason
 * as `content/lazy-mdx-video.tsx`, #481). Server rendering is kept, so the
 * HTML is unchanged; only the chunk is deferred until the component renders.
 *
 * Only client components belong here. The async server components in the
 * MDX map (`codehike/code`, `scrollycoding`, `quiz`) cannot be imported
 * from a client module and stay where they are.
 */
export const Mermaid = dynamic(() =>
	import('@coursebuilder/mdx-mermaid/client').then((mod) => mod.Mermaid),
)
export const Testimonial = dynamic(() =>
	import('@/app/admin/pages/_components/page-builder-mdx-components').then(
		(mod) => mod.Testimonial,
	),
)
export const TableWrapper = dynamic(() =>
	import('@/app/admin/pages/_components/page-builder-mdx-components').then(
		(mod) => mod.TableWrapper,
	),
)
export const Spoiler = dynamic(() =>
	import('@/app/admin/pages/_components/page-builder-mdx-components').then(
		(mod) => mod.Spoiler,
	),
)
export const ProjectVideo = dynamic(() =>
	import('@/app/admin/pages/_components/page-builder-mdx-components').then(
		(mod) => mod.ProjectVideo,
	),
)
export const MDXCheckbox = dynamic(() =>
	import('@/components/mdx-checkbox').then((mod) => mod.MDXCheckbox),
)
export const CommitMap = dynamic(() =>
	import('@/components/mdx/commit-map').then((mod) => mod.CommitMap),
)
export const Commit = dynamic(() =>
	import('@/components/mdx/commit-map').then((mod) => mod.Commit),
)
export const OfficeHoursSchedule = dynamic(() =>
	import('@/components/office-hours-schedule').then(
		(mod) => mod.OfficeHoursSchedule,
	),
)
