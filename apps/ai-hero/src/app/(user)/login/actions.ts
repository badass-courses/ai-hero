'use server'

import { headers } from 'next/headers'
import { env } from '@/env.mjs'
import { log } from '@/server/logger'

export async function getCsrf() {
	const headerStore = await headers()
	const cookie = headerStore.get('cookie')
	const options: RequestInit = {
		headers: {
			...(cookie ? { cookie } : {}),
		},
		cache: 'no-cache',
	}

	try {
		const response = await fetch(
			`${env.COURSEBUILDER_URL}/api/auth/csrf`,
			options,
		)
		const responseText = await response.text()
		const { csrfToken } = JSON.parse(responseText)

		return csrfToken
	} catch (error) {
		await log.debug('login.action.csrf.fetch-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
		throw error
	}
}
