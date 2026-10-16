// @vitest-environment happy-dom
import * as React from 'react'
import { act } from 'react'
import { MotionGlobalConfig } from 'framer-motion'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RESUME_CHIP_VISIBLE_MS, ResumeChip } from './resume-chip'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

describe('ResumeChip', () => {
	let container: HTMLDivElement
	let root: ReturnType<typeof createRoot>
	const onStartOver = vi.fn()

	function render(resumedAt: number | null) {
		act(() => {
			root.render(<ResumeChip resumedAt={resumedAt} onStartOver={onStartOver} />)
		})
	}

	const chip = () => container.querySelector('[role="status"]')
	// Motion removes an exiting element a frame later, even with animations
	// skipped.
	const expectGone = () =>
		vi.waitFor(() => {
			expect(chip()).toBeNull()
		})

	beforeEach(() => {
		MotionGlobalConfig.skipAnimations = true
		// Fake only the chip's timer; Motion's frame loop keeps real time.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		onStartOver.mockReset()
		container = document.createElement('div')
		document.body.appendChild(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
		vi.useRealTimers()
		MotionGlobalConfig.skipAnimations = false
	})

	it('says where playback resumed', () => {
		render(272)

		expect(chip()?.textContent).toContain('Resumed at 4:32')
		expect(chip()?.textContent).toContain('Start over')
	})

	it('renders nothing without a resume position', () => {
		render(null)

		expect(chip()).toBeNull()
	})

	it('starts over and hides on "Start over"', async () => {
		render(272)
		act(() => {
			container.querySelector('button')?.click()
		})

		expect(onStartOver).toHaveBeenCalledTimes(1)
		await expectGone()
	})

	it('fades out on its own after a few seconds', async () => {
		render(272)
		act(() => {
			vi.advanceTimersByTime(RESUME_CHIP_VISIBLE_MS - 1)
		})
		expect(chip()).not.toBeNull()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		await expectGone()
	})

	it('hides when the player clears the position', async () => {
		render(272)
		render(null)

		await expectGone()
	})

	it('shows again for a new resume position', () => {
		render(272)
		act(() => {
			vi.advanceTimersByTime(RESUME_CHIP_VISIBLE_MS)
		})
		render(95)

		expect(chip()?.textContent).toContain('Resumed at 1:35')
	})
})
