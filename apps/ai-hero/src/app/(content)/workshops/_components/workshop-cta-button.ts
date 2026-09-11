/**
 * The house gold CTA (`Workshop Landing.dc.html` § Sidebar): 46px tall, 9px
 * radius, 15px bold label, `bg-accent-fill` so it survives both themes.
 *
 * A plain module, not a client one: a string exported from a `'use client'`
 * file reaches a server component as a client reference, not a string, and
 * `cn()` silently drops it.
 */
export const WORKSHOP_CTA_BUTTON =
	'bg-accent-fill text-accent-fill-foreground hover:bg-accent-fill-hover h-[46px] cursor-pointer rounded-[9px] px-5 text-[15px] font-bold'
