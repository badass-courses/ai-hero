import { Suspense } from 'react'
import { type Metadata, type ResolvingMetadata } from 'next'
import { unstable_cache } from 'next/cache'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CourseCta } from '@/app/(content)/_components/course-cta'
import { ContentReadTracker } from '@/components/content-read-tracker'
import { BADGE_OUTLINE, TYPE } from '@/components/landing/type'
import type { CalloutIntent } from '@/components/mdx/callout'
import { Contributor } from '@/components/contributor'
import { MdxErrorBoundary } from '@/components/mdx/mdx-error-boundary'
import { PROSE_MEASURE } from '@/components/mdx/prose'
import { PlayerContainerSkeleton } from '@/components/player-skeleton'
import { Share } from '@/components/share'
import { courseBuilderAdapter } from '@/db'
import { getAiCodingDictionary } from '@/lib/ai-coding-dictionary'
import { getCachedAllLists, getCachedListForPost } from '@/lib/lists-query'
import { type Post } from '@/lib/posts'
import { getAllPosts, getCachedPostOrList } from '@/lib/posts-query'
import { resolvePostCta } from '@/lib/post-cta'
import { PostStructuredData } from '@/lib/structured-data'
import { getLatestCohort, getUpcomingCohort } from '@/lib/upcoming-cohort-query'
import { log } from '@/server/logger'
import { compileMDX } from '@/utils/compile-mdx'
import {
	flattenListResources,
	getListNeighborsFromList,
} from '@/utils/get-nextup-resource-from-list'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'
import { Github } from 'lucide-react'
import { Markdown as ReactMarkdown } from '@/components/markdown'
import readingTime from 'reading-time'

import { ContentResourceResource } from '@coursebuilder/core/schemas'
import { Button } from '@coursebuilder/ui'
import { VideoPlayerOverlayProvider } from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/utils/cn'

import { CopyPageButton } from '../_components/copy-page-button'
import {
	PostNewsletterCellSkeleton,
	type PostRelatedItem,
} from '../_components/post-related-newsletter'
import { PostUpNextPager } from '../_components/post-up-next-pager'
import {
	relatedItemMeta,
	resolveRelatedPostItems,
} from './_components/related-posts'
import { getRelatedSkillPosts, SkillExtras } from './_components/skill-extras'
import {
	SkillInstallPanel,
	SkillSectionRail,
	SkillStickyAction,
} from '@/components/skills'
import { getSkillSectionMap, type SkillSectionMap } from '@/lib/skills-query'
import ListPage from '../lists/[slug]/_page'
import { PostPlayer } from '../posts/_components/post-player'
import { getTocModel } from '../posts/_components/post-toc-model'
import {
	PostToCDisclosure,
	PostToCRail,
} from '../posts/_components/post-toc-rail'
import {
	PostShareDialogButton,
	PostSubscribeDialogButton,
} from './_components/post-header-dialog-buttons'
import { PostBodyCtaPlacement } from './_components/post-body-cta-placement'
import { PostClosingNewsletter } from './_components/post-closing-newsletter'
import { PostActionBar } from './_components/post-action-bar'
import { PostNextLessonButton } from './_components/post-next-lesson-button'
import {
	PersonalizedPostRelatedNewsletter,
	type RelatedPostPersonalization,
} from './_components/personalized-post-related-newsletter'

export const revalidate = 3600
export const dynamicParams = true
export const dynamic = 'force-static'

type Props = {
	params: Promise<{ post: string }>
}

export default async function PostPage(props: {
	params: Promise<{ post: string }>
}) {
	const params = await props.params

	const post = await getCachedPostOrList(params.post)

	if (!post) {
		notFound()
	}

	if (post.type === 'list') {
		return <ListPage list={post} params={{ slug: params.post } as any} />
	}

	let list = null
	if (post && post.type === 'post') {
		list = await getCachedListForPost(params.post)
	}

	const isSkillPost = post.type === 'post' && post.fields?.postType === 'skill'

	// What this post asks for below the body: the email course, when the `cta`
	// field says so or the post is a skill. Resolved here rather than inside the
	// body because the page ending depends on it too — see `showNewsletter`.
	const resolvedCta = resolvePostCta({
		postType: post.fields.postType,
		cta: post.fields.cta,
	})
	if (resolvedCta.warning) {
		void log.warn('post.cta.unrecognised', {
			postId: post.id,
			postType: post.fields.postType,
			slug: post.fields.slug,
		})
	}

	// W1 §5 — only plain articles get the cross-promo layers; podcast / tip /
	// skill-changelog / list keep their existing below-body behavior untouched.
	const isEligibleForCrossPromo =
		post.type === 'post' && post.fields?.postType === 'article'

	// The bottom of the page is one hairline grid per prototype: the lesson pager
	// (§ UP NEXT) when this post has neighbours in its list, then related reading
	// beside the newsletter (§ RELATED + NEWSLETTER). Both degrade to a single
	// spanning cell, or to nothing, rather than to an empty box.
	const neighbors = getListNeighborsFromList(list, post.id)

	// A skill post is a list member too, but its navigation is already the
	// SkillActions pager (previous / you are here / next) directly above. A second
	// pager under it would say the same thing twice, so the skill page ends the
	// way the prototype ends it: on RELATED + NEWSLETTER.
	const showLessonPager =
		!isSkillPost && Boolean(neighbors.prev || neighbors.next)
	// Mid-list, the pager IS the ending (the prototype's lesson page has nothing
	// under § UP NEXT). Everywhere else the page closes on the paired grid.
	const showRelatedNewsletter = !showLessonPager || !neighbors.next

	// Everything in the list, in the order the pager walks it.
	const listMembers = flattenListResources(list)

	// Does this post hold a POSITION in the list, as opposed to merely belonging
	// to it? `getListNeighborsFromList` trims unlisted and unpublished rows, so a
	// post can be a member in the CMS and still be absent here — which is the
	// difference between "the reader is somewhere in a sequence" and "the reader
	// is on a hidden page that happens to hang off a list."
	const isPositionedInList = listMembers.some(
		(entry) => entry.resource.id === post.id,
	)

	// The reader has reached the end of a list they were walking: they hold a
	// position in it and there is nothing after them.
	//
	// This matters because "More in {series}" is the wrong offer here, and this
	// is the ONLY place it was ever made. Mid-list the pager suppresses the whole
	// related grid (`showRelatedNewsletter` above), so the sibling strategy could
	// only ever fire at the end — at the one moment the siblings are the posts
	// the reader has just finished. It recommended the series backwards.
	//
	// Deliberately NOT `!neighbors.next` alone. Both neighbours are also null for
	// a post that has no position at all — one in no list, or one trimmed from
	// its own list for being unlisted — and the second of those is a reader who
	// has finished nothing. Excluding the enclosing list there would stop a
	// hidden mid-tutorial page from recommending its own tutorial, which is the
	// one thing it should recommend.
	//
	// A list with a single displayable lesson HAS to count, though: `prev` and
	// `next` are both null there and the reader has genuinely finished it. That
	// is why this keys on position rather than on having a previous lesson.
	//
	// Not skills. A skill post is a list member, but the list is a catalog rather
	// than a path: its own pager WRAPS (last → first), so no skill is an ending
	// and finishing one implies nothing about the other twenty. Treating the last
	// row of the catalog as a finale would cut a skill page off from the other
	// skills for no reason a reader would recognise.
	const isListFinale = !isSkillPost && isPositionedInList && !neighbors.next

	// The list AND its lessons, so discovery can be told to avoid the whole
	// thing. Flipping the variant alone would not have fixed anything: for a
	// lesson in a series the nearest neighbours by topic ARE its siblings, so
	// Typesense would hand back the same just-read posts.
	//
	// The list's own id belongs here for the same reason its lessons do, and it
	// is the easier one to miss. Lists are indexed alongside posts, so with only
	// the members excluded the top recommendation under the last lesson of the
	// MCP tutorial was the MCP tutorial: the reader is offered the front door of
	// the room they are standing at the back of.
	const listMemberIds =
		isListFinale && list
			? [list.id, ...listMembers.map((entry) => entry.resource.id)]
			: undefined

	// Related rows come from whichever source the shape has: a skill's own topic
	// tags first, then the article / discovery resolver. A skill with no topic
	// tags still gets rows rather than a half-empty grid.
	const related = !showRelatedNewsletter
		? { items: [], personalization: undefined }
		: await resolvePostRelatedItems({
				post,
				isSkillPost,
				variant:
					isEligibleForCrossPromo && !isListFinale
						? (post.fields?.relatedPostsVariant ?? 'section')
						: 'suggested',
				sectionTitle: list?.fields?.title,
				documentIdsToSkip: listMemberIds,
			})
	const relatedItems = related.items
	// The rail lists the page's non-heading endings alongside the article's own
	// h2s. Only what actually renders, in document order.
	//
	// Related rows are the test, not the newsletter. Whether the closing grid
	// carries an email ask is now a fact about the READER, resolved inside the
	// Suspense boundary below so this route can still be prerendered — so it is
	// not knowable here, and a rail entry labelled "Newsletter" pointing at a
	// grid a subscriber never receives is worse than no entry. With related rows
	// the grid always renders and the landmark is always true.
	const tocLandmarks = [
		...(showLessonPager ? [{ id: 'up-next', label: 'Up next' }] : []),
		...(showRelatedNewsletter && relatedItems.length > 0
			? [{ id: 'related-reading', label: 'Related reading' }]
			: []),
	]

	// The ToC is derived HERE, not from the body inside the two client
	// components that draw it. They each used to take `markdown` and parse it
	// themselves, which put the article's full source in the RSC payload twice
	// over — beside the compiled MDX tree that was already there.
	const tocModel = post.fields?.body
		? getTocModel(post.fields.body)
		: { sections: [], owners: [] }

	return (
		<main className="bg-card w-full dark:bg-transparent">
			<ContentReadTracker
				contentId={post.id}
				contentType="post"
				contentSlug={String(post.fields?.slug ?? params.post)}
			/>
			<PostStructuredData post={post} />
			<div className="relative w-full">
				<div className="relative z-10">
					{/* SEPARATORS ARE THE ARTICLE'S JOB, not each section's.
              A post has several possible endings — skill actions, a lesson
              pager, a related+newsletter grid, a mobile-only share row, any
              combination — and while each section hand-managed its own
              `border-t` / `border-b` the combinations kept producing either a
              doubled 2px rule (body's `border-b` meeting skill actions'
              `border-t`) or none at all.
              Every child after the first draws one top rule and pulls up 1px,
              so a child that brings its own `border-t` sets the same property
              instead of adding to it, and a previous child's `border-b` ends up
              underneath rather than stacked. Same idiom as `LandingBody`. The
              footer owns the rule below, so nothing is needed at the end. */}
					<article className="[&>*+*]:border-border relative flex h-full flex-col [&>*+*]:-mt-px [&>*+*]:border-t">
						<PostHead post={post} list={list} isSkillPost={isSkillPost} />
						{post?.fields?.body && (
							<PostToCDisclosure model={tocModel} landmarks={tocLandmarks} />
						)}
						{/* The spec's article shell: prose at the 70ch measure plus a
                232px sticky rail. The rail drops below `xl`, where
                PostToCDisclosure above stands in for it.

                The two side columns retire one at a time rather than together,
                because they do not cost the same: 264px of sidebar plus 232px
                of rail is 496px of chrome, and a window at half of a 1080p
                screen (960px) has only 960 to spend. Rail first at `xl`
                (1280), sidebar next at `lg` (1024) — so the half-width window
                reads one full-measure column, and the in-between widths keep
                the tree, which is the more load-bearing of the two. */}
						<div className="xl:grid xl:grid-cols-[minmax(0,1fr)_232px]">
							<PostBody post={post} resolvedCta={resolvedCta} />
							{post?.fields?.body && (
								<PostToCRail
									model={tocModel}
									title={post.fields?.title}
									landmarks={tocLandmarks}
								>
									{/* The rail's second block on a skill page is where that
                      skill sits in the workflow — the spec's slot, and the
                      one piece of orientation the body itself never gives. */}
									{isSkillPost && <SkillSectionRailForPost post={post} />}
								</PostToCRail>
							)}
						</div>
						{/* W2 — skill posts render the normal post template (video,
						    body, newsletter, next-up all intact); these are the only
						    skill-specific additions, appended below the body. */}
						{isSkillPost && (
						<SkillExtras
							post={post}
							// Same rule the closing newsletter follows below: when the
							// body already carried the course ask, this band does not
							// repeat it.
							//
							// "Carried", not "was configured to carry". `PostBody` returns
							// null for a post with no body, taking the CTA with it, so a
							// bodyless skill post would suppress this cell against an ask
							// that never rendered and offer the course nowhere at all.
							// Dropping a duplicate is the point; dropping the last one is
							// not.
							showFreeLesson={
								resolvedCta.kind !== 'course' || !post.fields?.body
							}
						/>
					)}
						{/* {listSlugFromParam && (
									<PostProgressToggle
										className="flex w-full items-center justify-center"
										postId={post.id}
									/>
								)} */}
						{/* Mobile only. On desktop the ToC rail carries share, and the head
                carries a Share button — three ways to do one thing, where the
                prototype has one. Below `xl` the rail is gone, so this row is
                the only share affordance and stays. */}
						{/* Literally the rail's own SHARE block, on the article gutter.
                It used to be the `inline` variant with a bold 18px "Share"
                heading, centred, and a lone `pl-5` — a different label style,
                a different button style and a different gutter from every
                other section of the page. */}
						<div className="flex w-full flex-col gap-2.5 px-[18px] py-8 sm:px-11 xl:hidden">
							<p className={TYPE.groupLabel}>Share</p>
							<Share variant="rail" title={post?.fields.title} />
						</div>
						{/* § UP NEXT — previous on the page surface, next on the band. */}
						{showLessonPager && (
							<PostUpNextPager
								id="up-next"
								postId={post.id}
								prev={neighbors.prev}
								next={neighbors.next}
							/>
						)}
						{/* § RELATED + NEWSLETTER — the two things a reader has left to do,
                paired in one grid instead of stacked as two bands. Mid-list the
                pager above is the whole ending, same as the prototype's lesson
                page. */}
						{showRelatedNewsletter && (
							// Suspended so this route can still be PRERENDERED.
							//
							// Whether the newsletter cell renders depends on the reader's
							// subscriber cookie, and awaiting that in the page body opts the
							// whole route out of static generation — which took fifteen
							// article and list pages off the prerender list for the sake of
							// one cell at the very bottom of them. Behind a boundary the
							// shell is still built ahead of time and only this grid is
							// resolved per request.
							//
							// `fallback={null}` rather than a skeleton: it is the last thing
							// on the page, below the fold, and a placeholder for a section
							// that may correctly turn out to be one cell wide would reserve
							// the wrong shape anyway. Same treatment as `PostActionBar`.
							<PersonalizedPostRelatedNewsletter
								id="related-reading"
								items={relatedItems}
								personalization={related.personalization}
								// A positioned member's exit IS its completion gesture: at a
								// list finale (and on every skill, whose pager wraps) this
								// grid is the closing navigation, and the lesson pager that
								// normally carries the write is absent or behind the reader.
								// A post that merely hangs off a list gets no tick for
								// leaving — same distinction `isListFinale` draws above.
								completesResourceId={
									isPositionedInList ? post.id : undefined
								}
								newsletter={
									// The body already ended on an email ask when the post
									// declares the course, so the closing grid drops its own
									// form and keeps related reading. Two forms for the same
									// address, three hundred pixels apart, is how the page
									// used to read.
									resolvedCta.kind === 'course' ? null : (
										<Suspense fallback={<PostNewsletterCellSkeleton />}>
											<PostClosingNewsletter postSlug={post.fields.slug} />
										</Suspense>
									)
								}
							/>
						)}
					</article>
					{/* Below 900px a skill page's primary action pins to the bottom.
              Rendered OUTSIDE `<article>` on purpose: the article's
              `[&>*+*]:border-t` would hand it a hairline it should not have.
              It pads the document for its own height — see the component. */}
					{isSkillPost && (
						<SkillStickyAction slug={String(post.fields?.slug ?? '')} />
					)}
				</div>
			</div>
			{/* {ckSubscriber && product && allowPurchase && pricingDataLoader ? (
						<section id="buy">
							<h2 className="text-2xl mb-10 text-balance px-5 text-center font-bold">
								Get Really Good At Node.js
							</h2>
							<div className="flex items-center justify-center border-y">
								<div className="bg-background flex w-full max-w-md flex-col border-x p-8">
									<PricingWidget
										quantityAvailable={-1}
										pricingDataLoader={pricingDataLoader}
										commerceProps={{ ...commerceProps }}
										product={product}
									/>
								</div>
							</div>
						</section>
					) : hasVideo ? null : ( */}
		</main>
	)
}

/**
 * The left cell of § RELATED + NEWSLETTER, for every post shape.
 *
 * Skills prefer their own topic tags (the same relation the skills index uses);
 * everything else, and any skill whose tags come up empty, falls back to the
 * article resolver so the grid never renders with one cell when the site has
 * something to suggest.
 */
async function resolvePostRelatedItems({
	post,
	isSkillPost,
	variant,
	sectionTitle,
	documentIdsToSkip,
}: {
	post: Post
	isSkillPost: boolean
	variant: 'section' | 'suggested'
	sectionTitle?: string
	/** Content the reader is done with — the finished list, at a list's end. */
	documentIdsToSkip?: string[]
}): Promise<{
	items: PostRelatedItem[]
	personalization?: RelatedPostPersonalization
}> {
	if (isSkillPost) {
		const fromTags = await getRelatedSkillPosts(post)
		if (fromTags.length > 0) {
			return { items: fromTags, personalization: undefined }
		}
	}

	const { items, source } = await resolveRelatedPostItems({
		postId: post.id,
		variant,
		sectionTitle,
		documentIdsToSkip,
	})

	return {
		items: items.map((item) => ({
			id: item.id,
			title: item.title,
			slug: item.slug,
			meta: relatedItemMeta(item),
		})),
		personalization:
			source === 'suggested'
				? { postId: post.id, variant, sectionTitle, documentIdsToSkip }
				: undefined,
	}
}

async function PostBody({
	post,
	resolvedCta,
}: {
	post: Post | null
	resolvedCta: ReturnType<typeof resolvePostCta>
}) {
	if (!post) {
		return null
	}

	if (!post.fields.body) {
		return null
	}

	const dictionary = await getAiCodingDictionary()
	const slug = String(post.fields?.slug ?? '')
	const isEligibleForCrossPromo =
		post.type === 'post' && post.fields?.postType === 'article'

	// A page that asks for the email course does not also get a cohort line
	// spliced into its prose. The two asks compete for the same click, and on
	// these pages — search traffic for a skill the reader already installed —
	// the course is the one that converts. `resolvedCta` decides; the cohort
	// cross-promo stands down.
	const wantsCohortCrossPromo =
		isEligibleForCrossPromo && resolvedCta.kind !== 'course'

	// W1 §2.3(b) / Q1 — the auto-inserted callout line is ALWAYS the 'course'
	// variant. Resolve the copy BEFORE compile (the remark plugin does no
	// data-fetching). Purchasable cohort → its title/page; between cohorts →
	// waitlist copy linking DIRECTLY to the latest cohort's page (the /cohorts
	// index is unused — Vojta, 2026-07-14). No cohort content at all → no line.
	let calloutLineAutoInsert:
		| { variant: CalloutIntent; label: string; href: string; linkText: string }
		| undefined
	if (wantsCohortCrossPromo) {
		const cohort = await getUpcomingCohort()
		if (cohort) {
			calloutLineAutoInsert = {
				variant: 'course',
				label: 'Go deeper:',
				href: `/cohorts/${cohort.slug}`,
				linkText: cohort.title,
			}
		} else {
			const latest = await getLatestCohort()
			if (latest) {
				calloutLineAutoInsert = {
					variant: 'course',
					label: 'Go deeper:',
					href: `/cohorts/${latest.slug}`,
					linkText: `join the waitlist for ${latest.title}`,
				}
			}
		}
	}

	const { content } = await compileMDX(
		post.fields.body,
		{},
		{},
		{
			lessonId: post.id,
			dictionaryAutoLink: {
				entries: dictionary.entries,
				maxLinks: 3,
			},
			...(calloutLineAutoInsert ? { calloutLineAutoInsert } : {}),
		},
	)

	return (
		<div className="px-[18px] pb-16 pt-10 sm:px-11 md:pb-20 md:pt-14">
			<article
				// `[&>*:last-child]:mb-0` — the column already pads its own bottom
				// (`pb-16 md:pb-20`), so whatever ends the article was adding its
				// margin on top of that padding. Ending on the cohort CTA, whose
				// `my-12` is sized to separate it from body copy, put 128px between
				// the card and the section rule below it and read as a hole.
				className={`prose prose-hr:border-border dark:prose-invert prose-a:text-primary sm:prose-lg lg:prose-lg mx-auto [&>*:last-child]:mb-0 ${PROSE_MEASURE}`}
			>
				{/* Never double up. Which of the three asks below the body wins is
				    `PostBodyCtaPlacement`'s decision, not this file's — the cohort CTA
				    is handed over unrendered so its cohort query only runs if it is
				    the one that gets the slot. */}
				<PostBodyCtaPlacement
					resolvedCta={resolvedCta}
					slug={slug}
					cohortCta={
						isEligibleForCrossPromo ? (
							<CourseCta
								postId={post.id}
								suppress={post.fields?.suppressCourseCta}
							/>
						) : null
					}
				>
					<MdxErrorBoundary>{content}</MdxErrorBoundary>
				</PostBodyCtaPlacement>
			</article>
		</div>
	)
}

function PostTitle({ post }: { post: Post }) {
	return (
		<h1 className={cn(TYPE.article, 'text-balance')}>
			<ReactMarkdown
				components={{
					p: ({ children }) => children,
					code: ({ children }) => (
						<code className="bg-muted/80 rounded-[4px] px-1 text-[85%]">
							{children}
						</code>
					),
				}}
			>
				{post?.fields?.title}
			</ReactMarkdown>
		</h1>
	)
}

// Durations, dates and counts on a row — meta, not an eyebrow.
const EYEBROW = TYPE.metaMark

/** "9 min read" — the same `reading-time` estimate RelatedPosts already shows. */
function getReadingLabel(body: string | null | undefined) {
	if (!body) return null
	const minutes = Math.max(1, Math.round(readingTime(body).minutes))
	return `${minutes} min read`
}

/** mm:ss, the way a player reports a runtime. */
function formatRuntime(seconds: number) {
	const whole = Math.round(seconds)
	const minutes = Math.floor(whole / 60)
	return `${minutes}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * The spec's two-column page head: title / byline / actions on the left, the
 * lesson video on the right. A post with no video is not a second template —
 * the right cell simply is not rendered and the grid collapses to one column.
 */
async function PostHead({
	post,
	list,
	isSkillPost,
}: {
	post: Post
	list: Awaited<ReturnType<typeof getCachedListForPost>>
	/** Skill posts carry the install panel directly under the title. */
	isSkillPost?: boolean
}) {
	const videoResourceId = post.resources?.find(
		({ resource }: ContentResourceResource) =>
			resource.type === 'videoResource',
	)?.resource.id

	const videoResource = videoResourceId
		? await _getCachedVideoResource(videoResourceId)
		: null
	// "01 / 07" only means something inside a guide; a standalone article has no
	// position to report, so the whole numeral drops rather than showing "01 / 1".
	// Counted over the FLATTENED list, the same order the pager below walks. On
	// a sectioned list `list.resources` holds the sections, not the lessons, so
	// counting it made the head disagree with the pager on the same screen —
	// "02 / 03" (sections) beside "Lesson 7" (lessons) — or find no match at all
	// and print nothing.
	const flattenedLessons = flattenListResources(list)
	const lessonIndex = flattenedLessons.findIndex(
		(resource: ContentResourceResource) => resource.resource.id === post.id,
	)
	const lessonCount = flattenedLessons.length
	const position =
		lessonIndex >= 0 && lessonCount > 1
			? `${String(lessonIndex + 1).padStart(2, '0')} / ${String(lessonCount).padStart(2, '0')}`
			: null

	const videoMinutes = videoResource?.duration
		? Math.max(1, Math.round(videoResource.duration / 60))
		: null

	// A post with a video is measured by its runtime, not by how long the
	// transcript takes to read — "5 min read" under a video the reader can see is
	// answering a question nobody asked. So the video's duration REPLACES the
	// reading label rather than joining it. When the resource carries no duration
	// (most of them don't yet) the head simply says nothing about length: the
	// player is right there and states its own.
	const metaLine = [
		list?.fields?.title,
		videoResource
			? videoMinutes
				? `${videoMinutes} min video`
				: null
			: getReadingLabel(post.fields?.body),
	]
		.filter(Boolean)
		.join(' · ')

	return (
		<div className="bg-card dark:bg-transparent">
			{/* The video leads, full width, above the title.
          The redesign prototype puts it in the right cell of a two-column
          head, which reads as an illustration beside the article rather than
          as the lesson. On a page whose whole point is "watch this", the
          video is the first-class object and the title introduces it, not the
          other way round. Deliberate deviation from the prototype. */}
			{videoResource && (
				<div className="border-b">
					<VideoPlayerOverlayProvider>
						<Suspense
							fallback={
								<PlayerContainerSkeleton className="aspect-video w-full bg-black" />
							}
						>
							<PostPlayer
								title={post.fields?.title}
								thumbnailTime={post.fields?.thumbnailTime || 0}
								postId={post.id}
								className="aspect-video w-full overflow-hidden"
								videoResource={videoResource}
							/>
						</Suspense>
					</VideoPlayerOverlayProvider>
				</div>
			)}
			<div>
				<div className="relative flex flex-col justify-center px-[18px] pb-10 pt-10 sm:px-11 md:pb-12 md:pt-12">
					{(position || metaLine) && (
						<div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1">
							{position && (
								<span className={cn(TYPE.badge, BADGE_OUTLINE, 'inline-flex w-fit')}>
									{position}
								</span>
							)}
							{metaLine && <span className={EYEBROW}>{metaLine}</span>}
						</div>
					)}
					<PostTitle post={post} />
					{post.fields?.description && (
						<p
							className={cn(
								TYPE.lead,
								'mt-4 max-w-[48ch] text-pretty text-[color:var(--ah-fg-muted)]',
							)}
						>
							{post.fields.description}
						</p>
					)}
					<div className="mt-7 flex w-full flex-wrap items-center justify-between gap-5">
						<div className="flex flex-wrap items-center gap-3">
							<Contributor className="text-foreground flex text-sm font-medium [&_img]:w-8" />
							<PostSubscribeDialogButton postSlug={post.fields?.slug} />
						</div>
						<div
							className={cn('flex flex-wrap items-center gap-2', {
								'grid w-full grid-cols-2 sm:flex sm:w-auto':
									post.fields?.github,
							})}
						>
							{post.fields?.github && (
								<Button
									asChild
									size="default"
									variant="ghost"
									className="rounded-[9px] border"
								>
									<Link href={post.fields?.github} target="_blank">
										<Github className="text-muted-foreground size-4" />
										Source Code
									</Link>
								</Button>
							)}
							{post.fields?.body && (
								<CopyPageButton
									variant="ghost"
									className="rounded-[9px] border"
									sourceUrl={`/api/posts/${encodeURIComponent(
										String(post.fields?.slug ?? ''),
									)}/markdown`}
								/>
							)}
							<PostShareDialogButton
								title={post.fields?.title}
								className="rounded-[9px]"
							/>
							<PostNextLessonButton
								postId={post.id}
								label={isSkillPost ? 'Next page' : 'Next lesson'}
								className="rounded-[9px]"
							/>
						</div>
					</div>
					<Suspense fallback={null}>
						<PostActionBar postId={post.id} postSlug={post.fields?.slug} />
					</Suspense>
				</div>
				{/* Directly under the title, which is where the mobile rules put it
            and where it belongs at every width: on a skill page the install
            line is the thing the reader came for. */}
				{isSkillPost && (
					<SkillInstallPanel
						slug={String(post.fields?.slug ?? '')}
						className="border-t"
					/>
				)}
			</div>
		</div>
	)
}

/**
 * The rail's workflow block. Its own component so the CMS read stays out of
 * `PostPage`, and so a post that is not a list member renders nothing rather
 * than an empty phase ladder.
 */
async function SkillSectionRailForPost({ post }: { post: Post }) {
	const { sections, placement } = await getSkillSectionMap().catch(
		(): SkillSectionMap => ({ sections: [], placement: {} }),
	)
	const slug = String(post.fields?.slug ?? '')

	return (
		<SkillSectionRail sections={sections} current={placement[slug] ?? null} />
	)
}

/**
 * Video lookups go through PlanetScale (no-store fetch). Wrapping in
 * unstable_cache contains that no-store inside a cache boundary so the page
 * can still be statically prerendered — without this the build's prerender
 * pass throws "Dynamic server usage" via the drizzle adapter's catch-and-
 * rethrow path and fails the build.
 */
const _getCachedVideoResource = (id: string) =>
	unstable_cache(
		async () => courseBuilderAdapter.getVideoResource(id),
		['post-video-resource-v1', id],
		{ revalidate: 3600, tags: [`video-resource:${id}`] },
	)()

export async function generateStaticParams() {
	const posts = await getAllPosts()
	const lists = await getCachedAllLists()

	const resources = [...posts, ...lists]

	return resources
		.filter(
			(resource) =>
				Boolean(resource.fields?.slug) &&
				resource.fields?.state === 'published' &&
				['public', 'unlisted'].includes(resource.fields?.visibility ?? ''),
		)
		.map((resource) => ({
			post: resource.fields?.slug,
		}))
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params

	const resource = await getCachedPostOrList(params.post)

	if (!resource) {
		return parent as Metadata
	}

	return {
		title: resource.fields.title,
		description: resource.fields.description,
		alternates: {
			canonical: `/${resource.fields.slug}`,
		},
		openGraph: {
			images: [
				// Hand-uploaded covers (source: 'uploaded') are authored at 1200×630
				// as finished share cards — serve them as-is; FAL-generated covers
				// and everything else keep the composed /api/og card.
				resource.type === 'post' &&
				resource.fields.coverImage?.source === 'uploaded' &&
				resource.fields.coverImage?.url
					? resource.fields.coverImage.url
					: getOGImageUrlForResource({
							fields: { slug: resource.fields.slug },
							id: resource.id,
							updatedAt: resource.updatedAt,
						}),
			],
		},
	}
}
