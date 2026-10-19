import { log } from '@/server/logger'

/** Do not log URLs, payloads or provider messages from the serve boundary. */
function executionIds(url: string) {
	try {
		const query = new URL(url).searchParams
		const id = (key: string) => {
			const value = query.get(key)
			return value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : null
		}
		return { fnId: id('fnId'), stepId: id('stepId') }
	} catch {
		return { fnId: null, stepId: null }
	}
}

export function withInngestFailureLogging<
	Args extends [{ url: string }, ...unknown[]],
	Result extends Response,
>(handler: (...args: Args) => Promise<Result>) {
	return async (...args: Args): Promise<Result> => {
		const report = async (status: number, errorClass: string) => {
			try {
				await log.error('inngest.serve.failed', {
					...executionIds(args[0].url),
					status,
					errorClass,
					message: 'Inngest serve request failed',
				})
			} catch {
				// Logging must never change the handler response or thrown value.
			}
		}
		let response: Result
		try {
			response = await handler(...args)
		} catch (error) {
			const name = error instanceof Error ? error.name : 'UnknownThrownValue'
			await report(500, /^[a-zA-Z0-9_]{1,80}$/.test(name) ? name : 'Error')
			throw error
		}
		if (response.status >= 500)
			await report(response.status, 'InngestServeResponseError')
		return response
	}
}
