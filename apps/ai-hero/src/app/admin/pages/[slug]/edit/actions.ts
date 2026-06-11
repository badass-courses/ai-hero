'use server'

import { redirect } from 'next/navigation'
import { log } from '@/server/logger'
import { serialize } from 'next-mdx-remote/serialize'

import { ContentResource } from '@coursebuilder/core/schemas'

export const onPageSave = async (resource: ContentResource) => {
	'use server'
	redirect(`/admin/coupons`)
}

export async function serializeForPreview(mdxSource: string) {
	try {
		const serializedResult = await serialize(mdxSource, { blockJS: false })
		return serializedResult
	} catch (error) {
		await log.error('admin.page.mdx-serialize.error', {
			error: error instanceof Error ? error.message : String(error),
		})

		return await serialize('Invalid MDX syntax. Please fix the error.')
	}
}
