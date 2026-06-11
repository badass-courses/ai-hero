import type { Metadata, ResolvingMetadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { courseBuilderAdapter } from '@/db'
import { getSkillChangelogForEdit } from '@/lib/skill-changelog-query'
import { getServerAuthSession } from '@/server/auth'
import { subject } from '@casl/ability'

import { EditSkillChangelogForm } from './_components/edit-skill-changelog-form'

export const dynamic = 'force-dynamic'

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

	return (
		<LayoutClient>
			<EditSkillChangelogForm
				key={entry.fields.slug}
				resource={entry}
				videoResource={videoResource}
			/>
		</LayoutClient>
	)
}
