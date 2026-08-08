import { env } from '@/env.mjs'
import { log } from '@/server/logger'

import ConvertkitProvider from '@coursebuilder/core/providers/convertkit'

import { retryKitWrite } from './kit-write-retry'

const convertkitProvider = ConvertkitProvider({
	apiKey: env.CONVERTKIT_API_KEY,
	apiSecret: env.CONVERTKIT_API_SECRET,
	defaultListType: 'form',
	defaultListId: env.CONVERTKIT_SIGNUP_FORM,
})

export const emailListProvider = {
	...convertkitProvider,
	subscribeToList: (
		options: Parameters<typeof convertkitProvider.subscribeToList>[0],
	) =>
		retryKitWrite({
			write: () => convertkitProvider.subscribeToList(options),
			onRetry: (receipt) =>
				log.warn('kit.write.retry', {
					operation: 'subscribe-to-list',
					...receipt,
				}),
		}),
}
