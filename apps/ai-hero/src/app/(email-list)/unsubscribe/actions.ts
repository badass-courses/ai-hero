'use server'

import { redirect } from 'next/navigation'
import { env } from '@/env.mjs'
import {
	parseUnsubscribeChoice,
	resolveDrovrApiBaseUrl,
	submitUnsubscribeChoice,
} from '@/lib/subscriber-marketing/drovr-unsubscribe-page'
import { log } from '@/server/logger'

/**
 * One press, one unsubscribe: posts the reader's choice to drovr, which
 * owns suppression and the Kit sync, then shows drovr's answer. The token
 * and masked address are never logged.
 */
export async function unsubscribeAction(formData: FormData) {
	const token = formData.get('t')?.toString()
	const choice = parseUnsubscribeChoice(formData.get('choice')?.toString())
	const params = new URLSearchParams({ t: token ?? '' })

	if (!choice) {
		redirect(`/unsubscribe?${params.toString()}`)
	}

	const result = await submitUnsubscribeChoice(token, choice, {
		baseUrl: resolveDrovrApiBaseUrl(env),
	})

	await log.info('unsubscribe-page.submit', {
		choice,
		result: result.status,
		...(result.status === 'ok'
			? {
					journeyId: result.state.course?.journeyId,
					allSubscribed: result.state.all.subscribed,
				}
			: {}),
		...(result.status === 'unavailable' ? { reason: result.reason } : {}),
	})

	if (result.status === 'ok') {
		params.set('updated', choice)
	} else if (result.status === 'invalid-token') {
		params.set('error', 'invalid')
	} else {
		params.set('choice', choice)
		params.set('error', 'unavailable')
	}
	redirect(`/unsubscribe?${params.toString()}`)
}
