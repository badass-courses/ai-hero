/**
 * DEV-ONLY workshop landing state preview — shared (server-safe) half.
 * See workshop-state-preview.tsx for the switcher UI and the full story.
 */
export const WORKSHOP_PREVIEW_STATES = [
	'waitlist',
	'pricing',
	'purchased',
	'in-progress',
	'completed',
	'no-product',
] as const

export type WorkshopPreviewState = (typeof WORKSHOP_PREVIEW_STATES)[number]

export function parseWorkshopPreviewState(
	value: string | string[] | undefined,
): WorkshopPreviewState | undefined {
	if (process.env.NODE_ENV !== 'development') return undefined
	return WORKSHOP_PREVIEW_STATES.find((s) => s === value)
}
