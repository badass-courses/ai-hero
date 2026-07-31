import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	post: vi.fn(),
	onSubmit: null as
		| null
		| ((
				values: { email: string; first_name: string },
				helpers: { setStatus: (status: string) => void },
		  ) => Promise<void>),
}))

vi.mock('axios', () => ({
	default: { post: mocks.post },
}))

vi.mock('formik', () => ({
	useFormik: (options: { onSubmit: typeof mocks.onSubmit }) => {
		mocks.onSubmit = options.onSubmit
		return {
			isSubmitting: false,
			status: '',
			handleChange: vi.fn(),
			handleSubmit: vi.fn(),
			errors: {},
			touched: {},
		}
	},
}))

import { useConvertkitForm } from './use-convertkit-form'

describe('useConvertkitForm success boundary', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.onSubmit = null
	})

	it('keeps a successful request successful when its callback rejects', async () => {
		const subscriber = {
			id: 42,
			email_address: 'reader@example.com',
			state: 'active',
			fields: {},
		}
		mocks.post.mockResolvedValue({ data: subscriber })
		const callbackError = new Error('navigation failed')
		const onSuccess = vi.fn().mockRejectedValue(callbackError)
		const onError = vi.fn()
		const setStatus = vi.fn()

		useConvertkitForm({ onSuccess, onError })
		await mocks.onSubmit?.(
			{ email: 'reader@example.com', first_name: 'Reader' },
			{ setStatus },
		)

		expect(setStatus).toHaveBeenCalledWith('success')
		expect(setStatus).not.toHaveBeenCalledWith('error')
		expect(onError).toHaveBeenCalledWith(callbackError)
	})

	it('still reports a request failure as an error', async () => {
		const requestError = new Error('request failed')
		mocks.post.mockRejectedValue(requestError)
		const onError = vi.fn()
		const setStatus = vi.fn()

		useConvertkitForm({ onSuccess: vi.fn(), onError })
		await mocks.onSubmit?.(
			{ email: 'reader@example.com', first_name: 'Reader' },
			{ setStatus },
		)

		expect(setStatus).toHaveBeenCalledWith('error')
		expect(onError).toHaveBeenCalledWith(requestError)
	})
})
