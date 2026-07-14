'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CmsVideoField } from '@/components/cms/cms-video-field'
import { createPostBindings } from '@/lib/cms/post-bindings'
import { PostSchema, type Post } from '@/lib/posts'
import { updatePost } from '@/lib/posts-query'
import type { Tag } from '@/lib/tags'
import type { UseFormReturn } from 'react-hook-form'

import type { VideoResource } from '@coursebuilder/core/schemas/video-resource'
import { createResourceEditor, postManifest } from '@coursebuilder/ui/cms'
import type {
	EditorCtx,
	FieldSpec,
	ListMembership,
} from '@coursebuilder/ui/cms/manifest'

import { postFormConfig } from '../../_components/post-form-config'

/**
 * The postTypes the editor offers. Deliberately NOT everything in
 * PostTypeSchema: posts are standalone content, not modules/wrappers, so the
 * legacy 'tip'/'course'/'playlist' values must not be offered as new choices.
 */
const POST_TYPE_OPTIONS = [
	'article',
	'podcast',
	'skill',
	'skill-changelog',
] as const

// 'skill-changelog' → 'Skill changelog'
function postTypeLabel(value: string) {
	return (value[0]!.toUpperCase() + value.slice(1)).replace('-', ' ')
}

/**
 * postManifest's tabs with a `fields.postType` selector inserted right after
 * the slug field on the Content tab (call-site spread — the shared manifest
 * in @coursebuilder/ui stays untouched).
 *
 * Options are the restricted allowlist, plus the post's CURRENT postType when
 * it falls outside it (legacy 'tip'/'course'/'playlist' posts exist in prod)
 * — without that extra option the native select would coerce the displayed
 * value and merely opening + saving a post would silently rewrite its
 * postType.
 *
 * The value shown for posts without a postType is 'article' — supplied by
 * `postFormConfig.defaultValues` (`post.fields?.postType || 'article'`), the
 * same fallback the save path applies (`createPostBindings` sends
 * `values.fields.postType || 'article'`) — so adding the selector changes no
 * defaults, it only makes the existing value visible and editable.
 */
function buildTabsWithPostType(currentPostType: string | undefined) {
	const values: string[] = [...POST_TYPE_OPTIONS]
	if (currentPostType && !values.includes(currentPostType)) {
		values.push(currentPostType)
	}
	const postTypeField: FieldSpec = {
		kind: 'select',
		name: 'fields.postType',
		label: 'Post type',
		options: values.map((value) => ({
			value,
			label: postTypeLabel(value),
		})),
	}
	return postManifest.tabs.map((tab) =>
		tab.label === 'Content'
			? {
					...tab,
					fields: tab.fields.flatMap((field): FieldSpec[] =>
						field.kind === 'slug' ? [field, postTypeField] : [field],
					),
				}
			: tab,
	)
}

export type EditPostClientProps = {
	post: Post
	videoResource: VideoResource | null
	/** Full tag vocabulary, server-fetched by the page (`getTags`). */
	tags: Tag[]
	/** Lists the post belongs to, server-fetched by the page (`getPostLists`). */
	listMemberships: ListMembership[]
	/**
	 * Mux Data configured? Server-computed by the page (the bindings factory
	 * runs client-side and can't read server env) — gates `videoAnalytics`.
	 */
	videoAnalyticsEnabled?: boolean
	/** Initial tab/panel URL slugs, read from `searchParams` on the server. */
	initialTab?: string
	initialPanel?: string
}

/**
 * Client wrapper for the cms post editor. The editor component is created
 * once per mount (NOT per render — a per-render `createResourceEditor` would
 * remount the whole form on every keystroke, the exact flaw of the legacy
 * `withResourceForm` wiring). Module scope isn't possible because the video
 * field, the tag vocabulary, and the router are per-request; the page keys
 * this component by slug, so a slug change remounts with fresh data.
 */
export function EditPostClient({
	post,
	videoResource,
	tags,
	listMemberships,
	videoAnalyticsEnabled,
	initialTab,
	initialPanel,
}: EditPostClientProps) {
	const router = useRouter()

	const PostEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...postManifest,
				// Content tab + the fields.postType selector (see buildTabsWithPostType).
				tabs: buildTabsWithPostType(post.fields?.postType),
				schema: PostSchema,
				// Reuse the legacy normalization (''/null fallbacks) so inputs stay
				// controlled — postFormConfig remains in use by other resource types.
				defaultValues: (resource) =>
					postFormConfig.defaultValues(resource as Post),
				// The manifest's `video: true` adds the Video tab; this slot fills it
				// with the shared cms wrapper (kit VideoField slots: player, replace,
				// choose-existing attach dialog, detach, transcript, thumbnail,
				// analytics, Open-in-Mux; chapters as children).
				videoSlot: (ctx: EditorCtx) => (
					<CmsVideoField
						// Same runtime object; cast bridges the linked ui package's own
						// react-hook-form copy (7.76) vs the app's (7.78) type identity.
						form={ctx.form as unknown as UseFormReturn<any>}
						resource={post}
						videoResource={videoResource}
						videoAnalyticsEnabled={videoAnalyticsEnabled}
						// Legacy parity: a thumbnail pick persists immediately via the
						// post's own save path (full-field snapshot from the live form).
						onThumbnailUpdate={async ({ thumbnailTime, videoResourceId }) => {
							const fields = (
								ctx.form as unknown as UseFormReturn<any>
							).getValues('fields')
							await updatePost(
								{
									id: post.id,
									fields: {
										...fields,
										thumbnailTime,
										videoResourceId,
									} as any,
								},
								'save',
							)
						}}
					/>
				),
			},
			bindings: createPostBindings({
				resourceId: post.id,
				availableTags: tags.map((tag) => ({
					id: tag.id,
					label: tag.fields.label,
				})),
				listMemberships,
				onSlugChange: (slug) => router.push(`/posts/${slug}/edit`),
				videoAnalyticsEnabled,
			}),
		})
		// Stable per mount by design; the page's key={slug} handles data changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	return (
		<PostEditor
			resource={post}
			// Server-seeded from searchParams so SSR matches the client tab.
			initialTab={initialTab}
			initialPanel={initialPanel}
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
