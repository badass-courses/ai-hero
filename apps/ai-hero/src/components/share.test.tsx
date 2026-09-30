import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const player: { current: { currentTime: number; duration: number } | null } = {
	current: null,
}

vi.mock('next/navigation', () => ({
	usePathname: () => '/some-post',
}))

vi.mock('@/env.mjs', () => ({
	env: { NEXT_PUBLIC_URL: 'https://www.aihero.dev' },
}))

vi.mock('@/hooks/use-mux-player', () => ({
	useMuxPlayer: () => ({ muxPlayerRef: player }),
}))

vi.mock('@/components/admin-shortlink-creator', () => ({
	AdminShortlinkCreator: () => null,
}))

vi.mock('@/utils/analytics', () => ({
	track: vi.fn(),
}))

import { parseStartAt, Share } from './share'

describe('parseStartAt', () => {
	it('reads the formats a reader types into the Start at field', () => {
		expect(parseStartAt('6:11')).toBe(371)
		expect(parseStartAt(' 1:02:03 ')).toBe(3723)
		expect(parseStartAt('371')).toBe(371)
		expect(parseStartAt('0:00')).toBe(0)
	})

	it('rejects anything that is not a time', () => {
		expect(parseStartAt('')).toBeNull()
		expect(parseStartAt('abc')).toBeNull()
		expect(parseStartAt('6:75')).toBeNull()
		expect(parseStartAt('-5')).toBeNull()
		// Digits past Number's range would otherwise become ?t=Infinity.
		expect(parseStartAt('9'.repeat(400))).toBeNull()
	})
})

describe('Share dialog Start at', () => {
	beforeEach(() => {
		player.current = null
	})

	it('offers the playhead, unticked, when the page has a player', () => {
		player.current = { currentTime: 371.8, duration: 900 }

		const markup = renderToStaticMarkup(<Share variant="dialog" title="Post" />)

		expect(markup).toContain('Start at')
		expect(markup).toMatch(/value="6:11"[^>]*disabled|disabled[^>]*value="6:11"/)
		// Unticked, so the link is the plain page URL.
		expect(markup).toContain('value="https://www.aihero.dev/some-post"')
		expect(markup).not.toContain('?t=')
	})

	it('has no Start at row without a player', () => {
		const markup = renderToStaticMarkup(<Share variant="dialog" title="Post" />)

		expect(markup).not.toContain('Start at')
	})

	it('keeps the rail free of the row even with a player', () => {
		player.current = { currentTime: 30, duration: 900 }

		const markup = renderToStaticMarkup(<Share variant="rail" title="Post" />)

		expect(markup).not.toContain('Start at')
	})
})
