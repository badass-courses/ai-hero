'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { createPostBindings } from '@/lib/cms/post-bindings'
import { PostSchema, type Post } from '@/lib/posts'
import type { Tag } from '@/lib/tags'
import type { UseFormReturn } from 'react-hook-form'

import type { VideoResource } from '@coursebuilder/core/schemas/video-resource'
import { createResourceEditor, postManifest } from '@coursebuilder/ui/cms'
import type { EditorCtx, ListMembership } from '@coursebuilder/ui/cms/manifest'

import { postFormConfig } from '../../_components/post-form-config'
import { VideoResourceField } from '../../_components/video-resource-field'

export type EditPostClientProps = {
	post: Post
	videoResource: VideoResource | null
	/** Full tag vocabulary, server-fetched by the page (`getTags`). */
	tags: Tag[]
	/** Lists the post belongs to, server-fetched by the page (`getPostLists`). */
	listMemberships: ListMembership[]
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
}: EditPostClientProps) {
	const router = useRouter()

	const PostEditor = React.useMemo(() => {
		return createResourceEditor({
			manifest: {
				...postManifest,
				schema: PostSchema,
				// Reuse the legacy normalization (''/null fallbacks) so inputs stay
				// controlled — postFormConfig remains in use by other resource types.
				defaultValues: (resource) =>
					postFormConfig.defaultValues(resource as Post),
				// The manifest's `video: true` adds the center Video tab; this slot
				// fills it with the existing post video field (self-contained:
				// socket updates + its own updatePost call).
				videoSlot: (ctx: EditorCtx) => (
					<VideoResourceField
						// Same runtime object; cast bridges the linked ui package's own
						// react-hook-form copy (7.76) vs the app's (7.78) type identity.
						form={ctx.form as unknown as UseFormReturn<any>}
						post={post}
						videoResource={videoResource}
						variant="panel"
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
