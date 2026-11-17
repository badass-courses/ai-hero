'use client'

import * as React from 'react'
import { Maximize2, Minimize2 } from 'lucide-react'

import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

import { LESSON_WIDE_ATTRIBUTE, LESSON_WIDE_KEY } from './lesson-wide-boot'

// The wide player is a viewer's choice of its own, separate from hiding the
// session panel: hiding the panel only gives the player the panel's width, so
// a problem and its solution play at the same size. Wide lifts the (learn)
// layout's page-width cap on every lesson, for learners on big monitors. The
// player keeps its 75svh height cap either way. Per browser, and every tab
// follows it. The key, attribute and boot script live in lesson-wide-boot.

const listeners = new Set<() => void>()

function subscribe(onChange: () => void) {
	listeners.add(onChange)
	const onStorage = (event: StorageEvent) => {
		if (event.key === LESSON_WIDE_KEY) onChange()
	}
	window.addEventListener('storage', onStorage)
	return () => {
		listeners.delete(onChange)
		window.removeEventListener('storage', onStorage)
	}
}

// Set only when storage refused the last write: the choice then lasts for
// this page, and reads must not fall back to the stale stored value.
let pageOnlyWide: boolean | null = null

function read() {
	if (pageOnlyWide !== null) return pageOnlyWide
	try {
		return window.localStorage.getItem(LESSON_WIDE_KEY) === '1'
	} catch {
		return false
	}
}

export function writeLessonWide(wide: boolean) {
	try {
		if (wide) window.localStorage.setItem(LESSON_WIDE_KEY, '1')
		else window.localStorage.removeItem(LESSON_WIDE_KEY)
		pageOnlyWide = null
	} catch {
		// Storage can be blocked or full; the choice then lasts for this page.
		pageOnlyWide = wide
	}
	for (const listener of listeners) listener()
}

/** The viewer's wide choice. Server render and hydration read it as off. */
export function useLessonWide() {
	return React.useSyncExternalStore(subscribe, read, () => false)
}

/**
 * Keeps the <html> attribute in step with the choice while lessons are on
 * screen, and removes it when they leave. A layout effect, so a client
 * navigation into the lessons applies it before paint. During hydration the
 * store reads off for one render; the boot script's attribute is left alone
 * until the real value arrives.
 */
export function useLessonWideAttribute() {
	const wide = useLessonWide()
	React.useLayoutEffect(() => {
		if (!wide) return
		const root = document.documentElement
		root.setAttribute(LESSON_WIDE_ATTRIBUTE, '')
		return () => root.removeAttribute(LESSON_WIDE_ATTRIBUTE)
	}, [wide])
}

/** Toolbar button under the player. Only from `xl`, where the cap binds. */
export function LessonWideToggle({ className }: { className?: string }) {
	const wide = useLessonWide()
	const Icon = wide ? Minimize2 : Maximize2
	return (
		<Button
			type="button"
			variant="ghost"
			aria-pressed={wide}
			onClick={() => writeLessonWide(!wide)}
			className={cn(
				'hover:bg-hover border-l-border hidden h-10 rounded-none border-0 border-l px-3 text-sm sm:h-12 xl:inline-flex',
				className,
			)}
		>
			<Icon className="text-muted-foreground size-4" aria-hidden />
			{wide ? 'Normal width' : 'Wide player'}
		</Button>
	)
}
