import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import { ActiveHeadingProvider } from '@/hooks/use-active-heading'
import { getCachedListForPost } from '@/lib/lists-query'
import { getModuleProgressForUser } from '@/lib/progress'

import { getCachedPostOrList } from '../../../lib/posts-query'
import { ListProvider } from './_components/list-provider'
import ListResourceNavigation, {
	MobileListResourceNavigation,
} from './_components/list-resource-navigation'
import { ProgressProvider } from './_components/progress-provider'

export default async function Layout(props: {
	children: React.ReactNode
	params: Promise<{ post: string }>
}) {
	const params = await props.params
	const post = await getCachedPostOrList(params.post)

	if (!post) {
		return <LayoutClient withContainer>{props.children}</LayoutClient>
	}

	let list = null
	if (post.type === 'post') {
		list = await getCachedListForPost(params.post)
	}
	const initialProgress = await getModuleProgressForUser(
		list ? list.id : params.post,
	)

	const currentPostHasVideo = Boolean(
		post?.resources?.find(
			(r: { resource: { type: string } }) =>
				r.resource.type === 'videoResource',
		),
	)

	// Context-dependent sidebar: posts that belong to a list/series keep the
	// in-series ListResourceNavigation; standalone posts (and list landing
	// pages) get the global docs-style hub sidebar. See
	// plans/navigation-redesign.md (Phase 3).
	const isPartOfSeries = Boolean(list)

	return (
		<ListProvider initialList={list} currentPostHasVideo={currentPostHasVideo}>
			<ProgressProvider initialProgress={initialProgress}>
				<ActiveHeadingProvider>
					<LayoutClient withContainer>
						{isPartOfSeries ? (
							<div className="flex flex-1">
								<ListResourceNavigation />
								<MobileListResourceNavigation />
								<div className="w-full min-w-0">{props.children}</div>
							</div>
						) : (
							<HubLayout>{props.children}</HubLayout>
						)}
					</LayoutClient>
				</ActiveHeadingProvider>
			</ProgressProvider>
		</ListProvider>
	)
}
