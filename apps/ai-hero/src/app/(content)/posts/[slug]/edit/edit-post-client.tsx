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
 * postTypes offered by the editor select. Posts are standalone content, not
 * modules/wrappers with child resources, so course/playlist/etc are not
 * offered even though PostTypeSchema accepts them. A legacy value outside
 * this list (e.g. 'tip') is still shown — see makeTabsWithPostType — so
 * opening + saving a post never silently rewrites its postType.
 */
const POST_TYPE_SELECT_OPTIONS = [
	'article',
	'podcast',
	'skill',
	'skill-changelog',
] as const

function postTypeLabel(value: string) {
	// 'skill-changelog' → 'Skill changelog'
	return (value[0]!.toUpperCase() + value.slice(1)).replace('-', ' ')
}

/**
 * `fields.postType` selector for the Content tab. The value shown for legacy
 * posts without a postType is 'article' — supplied by
 * `postFormConfig.defaultValues` (`post.fields?.postType || 'article'`), the
 * same fallback the save path applies (`createPostBindings` sends
 * `values.fields.postType || 'article'`) — so adding the selector changes no
 * defaults, it only makes the existing value visible and editable.
 */
function makePostTypeField(currentPostType: string | undefined): FieldSpec {
	const values: string[] = [...POST_TYPE_SELECT_OPTIONS]
	// Keep an out-of-allowlist current value selectable so the form stays
	// truthful and a plain save round-trips it unchanged.
	if (currentPostType && !values.includes(currentPostType)) {
		values.push(currentPostType)
	}
	return {
		kind: 'select',
		name: 'fields.postType',
		label: 'Post type',
		options: values.map((value) => ({ value, label: postTypeLabel(value) })),
	}
}

/**
 * postManifest's tabs with the postType selector inserted right after the
 * slug field on the Content tab (call-site spread — the shared manifest in
 * @coursebuilder/ui stays untouched).
 */
function makeTabsWithPostType(currentPostType: string | undefined) {
	const postTypeField = makePostTypeField(currentPostType)
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
}: EditPostClientProps) {
	const router = useRouter()

	const PostEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...postManifest,
				// Content tab + the fields.postType selector (see makeTabsWithPostType).
				tabs: makeTabsWithPostType(post.fields?.postType),
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
			// The shell defaults to h-dvh ("the shell IS the page"); subtract the
			// app nav it renders under.
			className="h-[calc(100dvh-var(--nav-height))]"
		/>
	)
}
