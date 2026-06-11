import { ARTWORK_ACTION_IDS, pickActionId } from '@/inngest/events/artwork'

type VariantBlocksOptions = {
	falUrls: string[]
	hookDescriptor?: string
	pickedIndex?: number
	pickedByUserId?: string
}

/**
 * Builds the variant message body — image blocks, per-variant Pick
 * buttons, and a final Regenerate row. Used by:
 *   - `generate-artwork.ts` for the initial post
 *   - `pick-variant.ts` for the post-pick re-render that keeps every
 *     option live so the user can swap their choice at any time
 *
 * When `pickedIndex` is supplied, that variant's button is styled
 * primary with a checkmark and the array is prefaced with a context
 * row stating who picked it.
 */
export function buildVariantBlocks({
	falUrls,
	hookDescriptor,
	pickedIndex,
	pickedByUserId,
}: VariantBlocksOptions): any[] {
	const blocks: any[] = []

	if (typeof pickedIndex === 'number' && pickedByUserId) {
		blocks.push({
			type: 'context',
			elements: [
				{
					type: 'mrkdwn',
					text: `✅ *Currently picked:* variant ${pickedIndex + 1} by <@${pickedByUserId}> — click another to swap, or regenerate.`,
				},
			],
		})
	}

	falUrls.forEach((url, idx) => {
		const altText = hookDescriptor
			? `${hookDescriptor} — variant ${idx + 1}`
			: `Variant ${idx + 1}`
		blocks.push({
			type: 'image',
			image_url: url,
			alt_text: altText,
			title: { type: 'plain_text', text: `Variant ${idx + 1}` },
		})
		const isPicked = idx === pickedIndex
		blocks.push({
			type: 'actions',
			block_id: `variant_actions_${idx}`,
			elements: [
				{
					type: 'button',
					...(isPicked || pickedIndex === undefined
						? { style: 'primary' as const }
						: {}),
					text: {
						type: 'plain_text',
						text: isPicked
							? `✓ Picked variant ${idx + 1}`
							: `Pick variant ${idx + 1}`,
						emoji: true,
					},
					action_id: pickActionId(idx),
					value: JSON.stringify({ falUrl: url }),
				},
			],
		})
	})

	blocks.push({
		type: 'actions',
		block_id: 'batch_actions',
		elements: [
			{
				type: 'button',
				text: { type: 'plain_text', text: '🔄 Regenerate', emoji: true },
				action_id: ARTWORK_ACTION_IDS.regenerate,
			},
		],
	})

	return blocks
}
