import type { Metadata, ResolvingMetadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { getPost, getPostLists } from '@/lib/posts-query'
import { getTags } from '@/lib/tags-query'
import { getServerAuthSession } from '@/server/auth'
import { subject } from '@casl/ability'

import type { ListMembership } from '@coursebuilder/ui/cms/manifest'

import { EditPostClient } from './edit-post-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

type Props = {
	params: Promise<{ slug: string }>
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params
	const post = await getPost(params.slug)

	if (!post) {
		return parent as Metadata
	}

	return {
		title: `📝 ${post.fields.title}`,
	}
}

export default async function ArticleEditPage(props: {
	params: Promise<{ slug: string }>
}) {
	const params = await props.params

	const { ability } = await getServerAuthSession()
	const post = await getPost(params.slug)

	if (!post || !ability.can('create', 'Content')) {
		notFound()
	}

	if (ability.cannot('manage', subject('Content', post))) {
		redirect(`/${post?.fields?.slug}`)
	}

	// Extract video resource from post resources
	const videoResourceRef =
		post.resources
			?.map((resource) => resource.resource)
			?.find((resource) => {
				return resource.type === 'videoResource'
			}) || null

	// Resolve video resource server-side instead of passing a loader
	let videoResource = null
	if (videoResourceRef) {
		try {
			videoResource = await courseBuilderAdapter.getVideoResource(
				videoResourceRef.id,
			)
		} catch (error) {
			console.error('Error loading video resource:', error)
		}
	}

	// Tag vocabulary for the editor's tag combobox (immediate entity writes),
	// plus the lists this post belongs to (seed for the lists membership field).
	const [tags, postLists] = await Promise.all([getTags(), getPostLists(post.id)])

	const listMemberships: ListMembership[] = postLists.map((list) => ({
		listId: list.id,
		title: list.fields.title,
		slug: list.fields.slug,
		href: `/lists/${list.fields.slug}/edit`,
	}))

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — Next's serialization warning
	// flags them on the `post` prop, and the editor's changed-indicator accepts
	// strings and Dates alike.
	const clientPost = {
		...post,
		createdAt: toIso(post.createdAt),
		updatedAt: toIso(post.updatedAt),
		deletedAt: toIso(post.deletedAt),
	} as typeof post

	return (
		<LayoutClient withFooter={false}>
			<EditPostClient
				key={post.fields.slug}
				post={clientPost}
				videoResource={videoResource}
				tags={tags}
				listMemberships={listMemberships}
				// Server-computed (client bindings can't read server env) — gates
				// the per-video analytics strip on Mux Data being configured.
				videoAnalyticsEnabled={Boolean(
					env.MUX_DATA_TOKEN_ID && env.MUX_DATA_TOKEN_SECRET,
				)}
			/>
		</LayoutClient>
	)
}
