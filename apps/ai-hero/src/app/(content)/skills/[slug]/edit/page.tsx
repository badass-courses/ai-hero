import type { Metadata, ResolvingMetadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { getSkillChangelogForEdit } from '@/lib/skill-changelog-query'
import { getServerAuthSession } from '@/server/auth'
import { subject } from '@casl/ability'

import { EditSkillChangelogClient } from './edit-skill-changelog-client'

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
	const entry = await getSkillChangelogForEdit(params.slug)

	if (!entry) {
		return parent as Metadata
	}

	return {
		title: `📝 ${entry.fields.title}`,
	}
}

export default async function SkillChangelogEditPage(props: {
	params: Promise<{ slug: string }>
}) {
	const params = await props.params

	const { ability } = await getServerAuthSession()
	const entry = await getSkillChangelogForEdit(params.slug)

	if (!entry || !ability.can('create', 'Content')) {
		notFound()
	}

	if (ability.cannot('manage', subject('Content', entry))) {
		redirect(`/skills/${entry.fields.slug}`)
	}

	const videoResourceRef =
		entry.resources
			?.map((r) => r.resource)
			?.find((r) => r.type === 'videoResource') || null

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

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — same toIso pattern as the post
	// edit page; the editor's changed-indicator accepts strings and Dates alike.
	const clientEntry = {
		...entry,
		createdAt: toIso(entry.createdAt),
		updatedAt: toIso(entry.updatedAt),
		deletedAt: toIso(entry.deletedAt),
	} as typeof entry

	return (
		<LayoutClient withFooter={false}>
			<EditSkillChangelogClient
				key={entry.fields.slug}
				entry={clientEntry}
				videoResource={videoResource}
				// Server-computed (client bindings can't read server env) — gates
				// the per-video analytics strip on Mux Data being configured.
				videoAnalyticsEnabled={Boolean(
					env.MUX_DATA_TOKEN_ID && env.MUX_DATA_TOKEN_SECRET,
				)}
			/>
		</LayoutClient>
	)
}
