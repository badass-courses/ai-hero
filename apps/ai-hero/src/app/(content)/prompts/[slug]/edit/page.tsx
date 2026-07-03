import * as React from 'react'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { getPrompt } from '@/lib/prompts-query'
import { getServerAuthSession } from '@/server/auth'

import { EditPromptClient } from './edit-prompt-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

export default async function PromptEditPage(props: {
	params: Promise<{ slug: string }>
}) {
	const params = await props.params
	await headers()
	const { ability } = await getServerAuthSession()
	const prompt = await getPrompt(params.slug)

	if (!prompt || !ability.can('create', 'Content')) {
		notFound()
	}

	// Serialize Date instances (createdAt/updatedAt from the DB driver) to ISO
	// strings before crossing the RSC boundary — same toIso pattern as the post
	// edit page; the editor's changed-indicator accepts strings and Dates alike.
	const clientPrompt = {
		...prompt,
		createdAt: toIso(prompt.createdAt),
		updatedAt: toIso(prompt.updatedAt),
		deletedAt: toIso(prompt.deletedAt),
	} as typeof prompt

	return (
		<LayoutClient withFooter={false}>
			<EditPromptClient key={prompt.fields.slug} prompt={clientPrompt} />
		</LayoutClient>
	)
}
