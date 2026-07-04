'use server'

import { revalidateTag } from 'next/cache'
import { courseBuilderAdapter, db } from '@/db'
import { contentResource } from '@/db/schema'
import { NewPrompt, Prompt, PromptSchema } from '@/lib/prompts'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { guid } from '@coursebuilder/utils/guid'
import slugify from '@sindresorhus/slugify'
import { eq, or, sql } from 'drizzle-orm'
import { v4 } from 'uuid'
import { z } from 'zod'

import { publishedAtStamp } from '@coursebuilder/ui/cms/resource-state'

export async function getPrompts(): Promise<Prompt[]> {
	const prompts = await db.query.contentResource.findMany({
		where: eq(contentResource.type, 'prompt'),
	})

	const promptsParsed = z.array(PromptSchema).safeParse(prompts)
	if (!promptsParsed.success) {
		void log.error('prompt.parse.error', {
			scope: 'prompts',
			error: promptsParsed.error.message,
		})
		return []
	}

	return promptsParsed.data
}

export async function createPrompt(input: NewPrompt) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user
	if (!user || !ability.can('create', 'Content')) {
		throw new Error('Unauthorized')
	}

	const newPromptId = v4()

	await db.insert(contentResource).values({
		id: newPromptId,
		type: 'prompt',
		fields: {
			title: input.fields.title,
			state: 'draft',
			visibility: 'unlisted',
			slug: slugify(`${input.fields.title}~${guid()}`),
		},
		createdById: user.id,
	})

	const prompt = await getPrompt(newPromptId)

	revalidateTag('prompts', 'max')

	return prompt
}

export async function updatePrompt(input: Prompt) {
	const { session, ability } = await getServerAuthSession()
	const user = session?.user
	if (!user || !ability.can('update', 'Content')) {
		throw new Error('Unauthorized')
	}

	const currentPrompt = await getPrompt(input.id)

	if (!currentPrompt) {
		return createPrompt(input)
	}

	// Slugs are intentionally NOT regenerated when the title changes — only an
	// explicit edit to the slug field changes the slug (same policy as
	// updatePost). This keeps published URLs stable when an author tweaks a
	// title.
	let promptSlug = currentPrompt.fields.slug

	if (
		input.fields.slug !== undefined &&
		input.fields.slug !== currentPrompt.fields.slug
	) {
		// An omitted slug (undefined) is a title-only edit and preserves the
		// current slug; an explicitly cleared slug is rejected rather than
		// silently ignored, since persisting an empty slug breaks the URL.
		if (!input.fields.slug) {
			throw new Error('Slug is required')
		}
		promptSlug = input.fields.slug
	}

	return courseBuilderAdapter.updateContentResourceFields({
		id: currentPrompt.id,
		fields: {
			...currentPrompt.fields,
			...input.fields,
			slug: promptSlug,
			// Stamp fields.publishedAt on the transition INTO 'published' (or
			// backfill a missing stamp) — same policy as updatePost.
			...publishedAtStamp(input.fields.state, currentPrompt.fields),
		},
	})
}

export async function getPrompt(slugOrId: string): Promise<Prompt | null> {
	const prompt = await db.query.contentResource.findFirst({
		where: or(
			eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slugOrId),
			eq(contentResource.id, slugOrId),
		),
	})

	const parsed = PromptSchema.safeParse(prompt)

	if (!parsed.success) {
		void log.error('prompt.parse.error', {
			scope: 'prompt',
			slugOrId,
			error: parsed.error.message,
		})
		return null
	}

	return parsed.data
}
