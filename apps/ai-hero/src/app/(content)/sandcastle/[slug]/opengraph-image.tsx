import { getSandcastleDocsPage } from '@/lib/sandcastle-docs'

import {
	renderSandcastleOg,
	SANDCASTLE_OG_SIZE,
} from '../_components/sandcastle-og'

export const revalidate = 3600
export const size = SANDCASTLE_OG_SIZE
export const contentType = 'image/png'
export const alt = 'Sandcastle docs'

export default async function SandcastleDocsOgImage({
	params,
}: {
	params: Promise<{ slug: string }>
}) {
	const found = await getSandcastleDocsPage((await params).slug)
	if (!found) return new Response('Not found', { status: 404 })
	const { page } = found

	return renderSandcastleOg({
		eyebrow: page.group,
		title: page.title,
		description: page.description,
	})
}
