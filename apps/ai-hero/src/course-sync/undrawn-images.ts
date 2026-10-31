import { undrawnImages } from '@/components/mdx/diagrams'

import type { SyncPlan } from './types'

export type UndrawnImage = { id: string; url: string; title: string | null }

/**
 * Images in the bodies this sync changed that have no redraw in code yet, so
 * the applied notice can ask for one. Retained resources are skipped: their
 * images were already asked about when they last changed. Detached ones are
 * lessons the source removed, which carry their old body and need no redraw.
 */
export function undrawnImagesInPlan(plan: SyncPlan): UndrawnImage[] {
	const images = new Map<string, UndrawnImage>()
	for (const item of plan.resources) {
		if (item.action === 'retain' || item.detached) continue
		const { body, title } = item.fields as { body?: unknown; title?: unknown }
		if (typeof body !== 'string') continue
		for (const image of undrawnImages(body)) {
			if (images.has(image.id)) continue
			images.set(image.id, {
				...image,
				title: typeof title === 'string' && title.trim() ? title.trim() : null,
			})
		}
	}
	return [...images.values()]
}
