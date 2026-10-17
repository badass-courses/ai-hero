export const SUBSCRIBE_BOT_ROUTES = {
	subscribe: '/api/coursebuilder/subscribe-to-list/convertkit',
	mode: '/api/subscribe-bot-mode',
	modeCacheSeconds: 5,
	modeTimeoutMs: 1000,
	discoveryReuseMs: 30_000,
}

export const SUBSCRIBE_BOT_PROTECT = [
	{ path: SUBSCRIBE_BOT_ROUTES.subscribe, method: 'POST' },
]
