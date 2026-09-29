'use client'

import * as React from 'react'

export type VideoPreviewPrefs = { sound: boolean; captions: boolean }

const STORAGE_KEY = 'video-preview-prefs'
/** YouTube's inline playback: muted, captions on, until the viewer says otherwise. */
const DEFAULTS: VideoPreviewPrefs = { sound: false, captions: true }

let current: VideoPreviewPrefs | null = null
const listeners = new Set<() => void>()

function read(): VideoPreviewPrefs {
	if (current) return current
	try {
		const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
		current = {
			sound: typeof stored.sound === 'boolean' ? stored.sound : DEFAULTS.sound,
			captions:
				typeof stored.captions === 'boolean' ? stored.captions : DEFAULTS.captions,
		}
	} catch {
		current = DEFAULTS
	}
	return current
}

function write(patch: Partial<VideoPreviewPrefs>) {
	current = { ...read(), ...patch }
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
	} catch {
		// Storage can be blocked; the choice still holds for this visit.
	}
	for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/**
 * Sound and captions for hover previews, shared by every card on the page and
 * remembered across visits: unmute one preview and the next plays with sound.
 * The server snapshot is the default so static HTML and hydration agree.
 */
export function useVideoPreviewPrefs() {
	const prefs = React.useSyncExternalStore(subscribe, read, () => DEFAULTS)
	return [prefs, write] as const
}
