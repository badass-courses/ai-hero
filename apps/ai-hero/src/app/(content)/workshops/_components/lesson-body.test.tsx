// @vitest-environment happy-dom

import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LessonBody } from './lesson-body'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((next) => {
		resolve = next
	})
	return { promise, resolve }
}

describe('LessonBody hash navigation', () => {
	let container: HTMLDivElement
	let root: ReturnType<typeof createRoot>
	const scrollIntoView = vi.fn()

	beforeEach(() => {
		window.location.hash = '#same-question-1'
		Element.prototype.scrollIntoView = scrollIntoView
		container = document.createElement('div')
		document.body.appendChild(container)
		root = createRoot(container)
	})

	afterEach(() => {
		act(() => root.unmount())
		container.remove()
		window.location.hash = ''
		vi.clearAllMocks()
	})

	it('scrolls to the hash target after the streamed body arrives', async () => {
		const body = deferred<{ content: React.ReactNode }>()
		await act(async () => {
			root.render(
				<React.Suspense fallback={<div>Loading lesson</div>}>
					<LessonBody
						lesson={null}
						workshop={null}
						abilityLoader={Promise.resolve({ canViewLesson: true } as never)}
						mdxContentPromise={body.promise}
						signedIn
					/>
				</React.Suspense>,
			)
		})
		expect(scrollIntoView).not.toHaveBeenCalled()

		await act(async () => {
			body.resolve({
				content: <h2 id="same-question-1">Same question</h2>,
			})
			await body.promise
		})

		await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce())
	})

	it('ignores a malformed encoded hash', async () => {
		window.location.hash = '#%E0%A4%A'
		await act(async () => {
			root.render(
				<React.Suspense fallback={<div>Loading lesson</div>}>
					<LessonBody
						lesson={null}
						workshop={null}
						abilityLoader={Promise.resolve({ canViewLesson: true } as never)}
						mdxContentPromise={Promise.resolve({
							content: <h2 id="question">Question</h2>,
						})}
						signedIn
					/>
				</React.Suspense>,
			)
		})

		expect(scrollIntoView).not.toHaveBeenCalled()
	})
})
