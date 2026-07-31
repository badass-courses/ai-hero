import LayoutClient from '@/components/layout-client'
import { HubLayout } from '@/components/navigation/hub-layout'
import { ActiveHeadingProvider } from '@/hooks/use-active-heading'
import type { List } from '@/lib/lists'
import {
	getCachedFilteredList,
	getCachedListForPost,
	getFilteredListForEditor,
} from '@/lib/lists-query'
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

	// A lesson resolves to the list it belongs to; a list landing page is its own
	// list. Either way the sidebar gets a list context, so the list's sidebar
	// entry reveals its lessons (+ an "Overview" row = this landing page).
	let list: List | null = null
	if (post.type === 'post') {
		list = await getCachedListForPost(params.post)
	} else if (post.type === 'list') {
		// NOT `post as unknown as List`: `getCachedPostOrList` loads one level
		// deep with no state/visibility predicate, so casting it here published
		// draft and unlisted lessons into the sidebar and the mobile lesson sheet,
		// and left sectioned lists with no lessons at all. This is the same
		// filtered, section-aware view the list body itself renders.
		list = await getCachedFilteredList(params.post)
		// `null` here means the list itself is draft or private — the public
		// loader refuses those. `getCachedPostOrList` above still SERVES a draft
		// list's page, so without this an editor previewing one got the page with
		// no list context at all: no sidebar lessons, no mobile lesson sheet. The
		// editor path resolves the session and so cannot be cached, which is why
		// it is reached only on the pages the public loader already rejected.
		if (!list) {
			list = await getFilteredListForEditor(params.post)
		}
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
	const isSkillPost = post.type === 'post' && post.fields?.postType === 'skill'
	const mobileListLabel = isSkillPost ? 'Pages' : 'Lessons'

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
					<LayoutClient withContainer withFooter={false}>
						<HubLayout
							hideWhatsNew={post.type === 'post'}
							currentListSlug={list?.fields.slug}
						>
							{props.children}
						</HubLayout>
						{/* A skill page pins its install action to the bottom edge, so the
					    list stays a floating trigger there rather than a second bar. */}
					<MobileListResourceNavigation
						label={mobileListLabel}
						variant={isSkillPost ? 'floating' : 'bar'}
					/>
					</LayoutClient>
				</ActiveHeadingProvider>
			</ProgressProvider>
		</ListProvider>
	)
}
