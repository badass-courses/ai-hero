import { Suspense } from "react";
import { type Metadata, type ResolvingMetadata } from "next";
import { unstable_cache } from "next/cache";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseCta } from "@/app/(content)/_components/course-cta";
import {
  OrganicOpportunityCta,
  organicOpportunityCtaBySlug,
} from "@/app/(content)/_components/organic-opportunity-cta";
import { ContentReadTracker } from "@/components/content-read-tracker";
import { TYPE } from "@/components/landing/type";
import type { CalloutIntent } from "@/components/mdx/callout";
import { Contributor } from "@/components/contributor";
import { MdxErrorBoundary } from "@/components/mdx/mdx-error-boundary";
import { PROSE_MEASURE } from "@/components/mdx/prose";
import { PlayerContainerSkeleton } from "@/components/player-skeleton";
import { Share } from "@/components/share";
import { courseBuilderAdapter } from "@/db";
import { getAiCodingDictionary } from "@/lib/ai-coding-dictionary";
import { getAllLists, getCachedListForPost } from "@/lib/lists-query";
import { type Post } from "@/lib/posts";
import { getAllPosts, getCachedPostOrList } from "@/lib/posts-query";
import { PostStructuredData } from "@/lib/structured-data";
import {
  getLatestCohort,
  getUpcomingCohort,
} from "@/lib/upcoming-cohort-query";
import { getServerAuthSession } from "@/server/auth";
import { compileMDX } from "@/utils/compile-mdx";
import { getListNeighborsFromList } from "@/utils/get-nextup-resource-from-list";
import { getOGImageUrlForResource } from "@/utils/get-og-image-url-for-resource";
import { Github } from "lucide-react";
import ReactMarkdown from "react-markdown";
import readingTime from "reading-time";

import { ContentResourceResource } from "@coursebuilder/core/schemas";
import { Button } from "@coursebuilder/ui";
import { VideoPlayerOverlayProvider } from "@coursebuilder/ui/hooks/use-video-player-overlay";
import { cn } from "@coursebuilder/utils/cn";

import { CopyPageButton } from "../_components/copy-page-button";
import {
  PostRelatedNewsletter,
  type PostRelatedItem,
} from "../_components/post-related-newsletter";
import { PostUpNextPager } from "../_components/post-up-next-pager";
import {
  relatedItemMeta,
  resolveRelatedPostItems,
} from "./_components/related-posts";
import { getRelatedSkillPosts, SkillExtras } from "./_components/skill-extras";
import {
  SkillInstallPanel,
  SkillPhaseRail,
  SkillStickyAction,
  workflowPhases,
} from "@/components/skills";
import { getSkillEntries } from "@/lib/skills-query";
import ListPage from "../lists/[slug]/_page";
import { PostPlayer } from "../posts/_components/post-player";
import {
  PostToCDisclosure,
  PostToCRail,
} from "../posts/_components/post-toc-rail";
import {
  PostShareDialogButton,
  PostSubscribeDialogButton,
} from "./_components/post-header-dialog-buttons";
import { PostNextLessonButton } from "./_components/post-next-lesson-button";

type Props = {
  params: Promise<{ post: string }>;
};

export default async function PostPage(props: {
  params: Promise<{ post: string }>;
}) {
  const params = await props.params;

  const post = await getCachedPostOrList(params.post);

  if (!post) {
    notFound();
  }

  if (post.type === "list") {
    return <ListPage list={post} params={{ slug: params.post } as any} />;
  }

  let list = null;
  if (post && post.type === "post") {
    list = await getCachedListForPost(params.post);
  }

  const isSkillPost = post.type === "post" && post.fields?.postType === "skill";

  // W1 §5 — only plain articles get the cross-promo layers; podcast / tip /
  // skill-changelog / list keep their existing below-body behavior untouched.
  const isEligibleForCrossPromo =
    post.type === "post" && post.fields?.postType === "article";

  // The bottom of the page is one hairline grid per prototype: the lesson pager
  // (§ UP NEXT) when this post has neighbours in its list, then related reading
  // beside the newsletter (§ RELATED + NEWSLETTER). Both degrade to a single
  // spanning cell, or to nothing, rather than to an empty box.
  const neighbors = getListNeighborsFromList(list, post.id);

  // A skill post is a list member too, but its navigation is already the
  // SkillActions pager (previous / you are here / next) directly above. A second
  // pager under it would say the same thing twice, so the skill page ends the
  // way the prototype ends it: on RELATED + NEWSLETTER.
  const showLessonPager = !isSkillPost && Boolean(neighbors.prev || neighbors.next);
  // Mid-list, the pager IS the ending (the prototype's lesson page has nothing
  // under § UP NEXT). Everywhere else the page closes on the paired grid.
  const showRelatedNewsletter = !showLessonPager || !neighbors.next;

  // Related rows come from whichever source the shape has: a skill's own topic
  // tags first, then the article / discovery resolver. A skill with no topic
  // tags still gets rows rather than a half-empty grid.
  const relatedItems: PostRelatedItem[] = !showRelatedNewsletter
    ? []
    : await resolvePostRelatedItems({
        post,
        isSkillPost,
        variant: isEligibleForCrossPromo
          ? (post.fields?.relatedPostsVariant ?? "section")
          : "suggested",
        sectionTitle: list?.fields?.title,
      });
  const markdownToCopy = `# ${post?.fields?.title}

${post?.fields?.body}`;

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
            <PostHead
              post={post}
              list={list}
              markdownToCopy={markdownToCopy}
              isSkillPost={isSkillPost}
            />
            {post?.fields?.body && (
              <PostToCDisclosure markdown={post.fields.body} />
            )}
            {/* The spec's article shell: prose at the 70ch measure plus a
                232px sticky rail. The rail drops below `md`, where
                PostToCDisclosure above stands in for it. */}
            <div className="md:grid md:grid-cols-[minmax(0,1fr)_232px]">
              <PostBody post={post} />
              {post?.fields?.body && (
                <PostToCRail
                  markdown={post.fields.body}
                  title={post.fields?.title}
                >
                  {/* The rail's second block on a skill page is where that
                      skill sits in the workflow — the spec's slot, and the
                      one piece of orientation the body itself never gives. */}
                  {isSkillPost && <SkillPhaseRailForPost post={post} />}
                </PostToCRail>
              )}
            </div>
            {/* W2 — skill posts render the normal post template (video,
						    body, newsletter, next-up all intact); these are the only
						    skill-specific additions, appended below the body. */}
            {isSkillPost && <SkillExtras post={post} />}
            {/* {listSlugFromParam && (
									<PostProgressToggle
										className="flex w-full items-center justify-center"
										postId={post.id}
									/>
								)} */}
            {/* Mobile only. On desktop the ToC rail carries share, and the head
                carries a Share button — three ways to do one thing, where the
                prototype has one. Below `md` the rail is gone, so this row is
                the only share affordance and stays. */}
            <div className="flex w-full flex-wrap items-center justify-center gap-5 pl-5 md:hidden">
              <strong className="text-lg font-semibold">Share</strong>
              <Share
                className="inline-flex rounded-none border-y-0"
                title={post?.fields.title}
              />
            </div>
            {/* § UP NEXT — previous on the page surface, next on the band. */}
            {showLessonPager && (
              <PostUpNextPager
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
              <PostRelatedNewsletter
                items={relatedItems}
                trackParams={{
                  post: post.fields.slug,
                  location: "post",
                }}
              />
            )}
          </article>
          {/* Below 900px a skill page's primary action pins to the bottom.
              Rendered OUTSIDE `<article>` on purpose: the article's
              `[&>*+*]:border-t` would hand it a hairline it should not have.
              It pads the document for its own height — see the component. */}
          {isSkillPost && (
            <SkillStickyAction slug={String(post.fields?.slug ?? "")} />
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
  );
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
}: {
  post: Post;
  isSkillPost: boolean;
  variant: "section" | "suggested";
  sectionTitle?: string;
}): Promise<PostRelatedItem[]> {
  if (isSkillPost) {
    const fromTags = await getRelatedSkillPosts(post);
    if (fromTags.length > 0) return fromTags;
  }

  const { items } = await resolveRelatedPostItems({
    postId: post.id,
    variant,
    sectionTitle,
  });

  return items.map((item) => ({
    id: item.id,
    title: item.title,
    slug: item.slug,
    meta: relatedItemMeta(item),
  }));
}

async function PostBody({ post }: { post: Post | null }) {
  if (!post) {
    return null;
  }

  if (!post.fields.body) {
    return null;
  }

  const dictionary = await getAiCodingDictionary();
  const slug = String(post.fields?.slug ?? "");
  const ctaKind = organicOpportunityCtaBySlug[slug];

  const isEligibleForCrossPromo =
    post.type === "post" && post.fields?.postType === "article";

  // W1 §2.3(b) / Q1 — the auto-inserted callout line is ALWAYS the 'course'
  // variant. Resolve the copy BEFORE compile (the remark plugin does no
  // data-fetching). Purchasable cohort → its title/page; between cohorts →
  // waitlist copy linking DIRECTLY to the latest cohort's page (the /cohorts
  // index is unused — Vojta, 2026-07-14). No cohort content at all → no line.
  let calloutLineAutoInsert:
    | { variant: CalloutIntent; label: string; href: string; linkText: string }
    | undefined;
  if (isEligibleForCrossPromo) {
    const cohort = await getUpcomingCohort();
    if (cohort) {
      calloutLineAutoInsert = {
        variant: "course",
        label: "Go deeper:",
        href: `/cohorts/${cohort.slug}`,
        linkText: cohort.title,
      };
    } else {
      const latest = await getLatestCohort();
      if (latest) {
        calloutLineAutoInsert = {
          variant: "course",
          label: "Go deeper:",
          href: `/cohorts/${latest.slug}`,
          linkText: `join the waitlist for ${latest.title}`,
        };
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
  );

  return (
    <div className="px-8 pb-16 pt-10 sm:px-11 md:pb-20 md:pt-14">
      <article
        className={`prose prose-hr:border-border dark:prose-invert prose-a:text-primary sm:prose-lg lg:prose-lg mx-auto ${PROSE_MEASURE}`}
      >
        <MdxErrorBoundary>{content}</MdxErrorBoundary>
        {/* Q4 — never double up: keep OrganicOpportunityCta for the slugs it
				    already covers (any post type, existing behavior); otherwise render
				    the generalized CourseCta only for eligible articles. */}
        {ctaKind ? (
          <OrganicOpportunityCta kind={ctaKind} />
        ) : isEligibleForCrossPromo ? (
          <CourseCta
            postId={post.id}
            suppress={post.fields?.suppressCourseCta}
          />
        ) : null}
      </article>
    </div>
  );
}

function PostTitle({ post }: { post: Post }) {
  return (
    <h1 className={cn(TYPE.article, "text-balance")}>
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
  );
}

const EYEBROW = cn(TYPE.micro, "text-[color:var(--ah-fg-label)]");

/** "9 min read" — the same `reading-time` estimate RelatedPosts already shows. */
function getReadingLabel(body: string | null | undefined) {
  if (!body) return null;
  const minutes = Math.max(1, Math.round(readingTime(body).minutes));
  return `${minutes} min read`;
}

/** mm:ss, the way a player reports a runtime. */
function formatRuntime(seconds: number) {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The spec's two-column page head: title / byline / actions on the left, the
 * lesson video on the right. A post with no video is not a second template —
 * the right cell simply is not rendered and the grid collapses to one column.
 */
async function PostHead({
  post,
  list,
  markdownToCopy,
  isSkillPost,
}: {
  post: Post;
  list: Awaited<ReturnType<typeof getCachedListForPost>>;
  markdownToCopy: string;
  /** Skill posts carry the install panel directly under the title. */
  isSkillPost?: boolean;
}) {
  const videoResourceId = post.resources?.find(
    ({ resource }: ContentResourceResource) =>
      resource.type === "videoResource",
  )?.resource.id;

  const videoResource = videoResourceId
    ? await _getCachedVideoResource(videoResourceId)
    : null;
  // "01 / 07" only means something inside a guide; a standalone article has no
  // position to report, so the whole numeral drops rather than showing "01 / 1".
  const lessonIndex =
    list?.resources?.findIndex(
      (resource: ContentResourceResource) => resource.resource.id === post.id,
    ) ?? -1;
  const lessonCount = list?.resources?.length ?? 0;
  const position =
    lessonIndex >= 0 && lessonCount > 1
      ? `${String(lessonIndex + 1).padStart(2, "0")} / ${String(lessonCount).padStart(2, "0")}`
      : null;

  const videoMinutes = videoResource?.duration
    ? Math.max(1, Math.round(videoResource.duration / 60))
    : null;

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
    .join(" · ");

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
        <div className="relative flex flex-col justify-center px-8 pb-10 pt-10 sm:px-11 md:pb-12 md:pt-12">
          {(position || metaLine) && (
            <div className="mb-4 flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {position && (
                <span className={cn(TYPE.micro, "text-primary")}>
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
                "mt-4 max-w-[48ch] text-pretty text-[color:var(--ah-fg-muted)]",
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
              className={cn("flex flex-wrap items-center gap-2", {
                "grid w-full grid-cols-2 sm:flex sm:w-auto":
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
                  markdown={markdownToCopy}
                />
              )}
              <PostShareDialogButton
                title={post.fields?.title}
                className="rounded-[9px]"
              />
              <PostNextLessonButton
                postId={post.id}
                className="rounded-[9px]"
              />
            </div>
          </div>
          <Suspense fallback={null}>
            <PostActionBar post={post} />
          </Suspense>
        </div>
        {/* Directly under the title, which is where the mobile rules put it
            and where it belongs at every width: on a skill page the install
            line is the thing the reader came for. */}
        {isSkillPost && (
          <SkillInstallPanel
            slug={String(post.fields?.slug ?? "")}
            className="border-t"
          />
        )}
      </div>
    </div>
  );
}

/**
 * The rail's workflow block. Its own component so the CMS read stays out of
 * `PostPage`, and so a post that is not a list member renders nothing rather
 * than an empty phase ladder.
 */
async function SkillPhaseRailForPost({ post }: { post: Post }) {
  const entries = await getSkillEntries().catch(() => []);
  const slug = String(post.fields?.slug ?? "");
  const entry = entries.find((candidate) => candidate.slug === slug);

  return (
    <SkillPhaseRail
      phases={workflowPhases(entries)}
      current={entry?.phase ?? null}
    />
  );
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
    ["post-video-resource-v1", id],
    { revalidate: 3600, tags: [`video-resource:${id}`] },
  )();

export async function generateStaticParams() {
  const posts = await getAllPosts();
  const lists = await getAllLists();

  const resources = [...posts, ...lists];

  return resources
    .filter((resource) => Boolean(resource.fields?.slug))
    .map((resource) => ({
      post: resource.fields?.slug,
    }));
}

export async function generateMetadata(
  props: Props,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const params = await props.params;

  const resource = await getCachedPostOrList(params.post);

  if (!resource) {
    return parent as Metadata;
  }

  return {
    title: resource.fields.title,
    description: resource.fields.description,
    alternates: {
      canonical: `/${resource.fields.slug}`,
    },
    openGraph: {
      images: [
        getOGImageUrlForResource({
          fields: { slug: resource.fields.slug },
          id: resource.id,
          updatedAt: resource.updatedAt,
        }),
      ],
    },
  };
}

async function PostActionBar({ post }: { post: Post | null }) {
  const { session, ability } = await getServerAuthSession();

  return (
    <>
      {post && ability.can("update", "Content") ? (
        <Button asChild size="sm" className="absolute right-0 top-0 z-50">
          <Link href={`/posts/${post.fields?.slug || post.id}/edit`}>Edit</Link>
        </Button>
      ) : null}
    </>
  );
}
