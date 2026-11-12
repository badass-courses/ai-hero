// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	mutate: vi.fn(),
	invalidate: vi.fn(),
}))

vi.mock('@/trpc/react', () => ({
	api: {
		useUtils: () => ({
			client: { progress: { setCompleted: { mutate: mocks.mutate } } },
			progress: { completedOf: { invalidate: mocks.invalidate } },
		}),
	},
}))

import { useSetLessonCompleted } from './use-set-lesson-completed'

async function getHook() {
	let hook: ReturnType<typeof useSetLessonCompleted> | undefined
	function Probe() {
		hook = useSetLessonCompleted()
		return null
	}
	const root = createRoot(document.createElement('div'))
	await act(async () => root.render(<Probe />))
	return hook!
}

describe('useSetLessonCompleted', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('writes, returns the result, then invalidates completedOf', async () => {
		mocks.mutate.mockResolvedValue({ resourceId: 'l1' })
		const setCompleted = await getHook()

		await expect(
			setCompleted({ resourceId: 'l1', isCompleted: true }),
		).resolves.toEqual({ resourceId: 'l1' })
		expect(mocks.mutate).toHaveBeenCalledWith({
			resourceId: 'l1',
			isCompleted: true,
		})
		expect(mocks.invalidate).toHaveBeenCalledTimes(1)
	})

	it('still invalidates and rethrows when the write fails', async () => {
		mocks.mutate.mockRejectedValue(new Error('offline'))
		const setCompleted = await getHook()

		await expect(
			setCompleted({ resourceId: 'l1', isCompleted: false }),
		).rejects.toThrow('offline')
		expect(mocks.invalidate).toHaveBeenCalledTimes(1)
	})
})
