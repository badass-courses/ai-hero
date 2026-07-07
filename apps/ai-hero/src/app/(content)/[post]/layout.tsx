import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import { ActiveHeadingProvider } from '@/hooks/use-active-heading'
import { getCachedListForPost } from '@/lib/lists-query'
import { getModuleProgressForUser } from '@/lib/progress'

import { getCachedPostOrList } from '../../../lib/posts-query'
import { ListProvider } from './_components/list-provider'
import { MobileListResourceNavigation } from './_components/list-resource-navigation'
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

	// Every post gets the global hub sidebar (Amy's call — keep the breadth).
	// Series posts additionally pin an "In this series" group at the top of that
	// sidebar (PinnedSeriesNav, from the list context) instead of replacing the
	// whole rail with a lesson list. "What's New" is hidden on standalone
	// articles (post.type === 'post'); list landing pages keep it. Mobile keeps
	// its dedicated lessons sheet since the desktop sidebar is hidden there.
	return (
		<ListProvider initialList={list} currentPostHasVideo={currentPostHasVideo}>
			<ProgressProvider initialProgress={initialProgress}>
				<ActiveHeadingProvider>
					<LayoutClient withContainer>
						<HubLayout
							hideWhatsNew={post.type === 'post'}
							currentListSlug={list?.fields.slug}
						>
							{props.children}
						</HubLayout>
						<MobileListResourceNavigation />
					</LayoutClient>
				</ActiveHeadingProvider>
			</ProgressProvider>
		</ListProvider>
	)
}
