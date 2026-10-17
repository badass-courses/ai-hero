export const SUBSCRIBE_BOT_CONFIG = {
	name: {
		minimumLength: 8,
		minimumInnerCapitals: 3,
		letters: /^[a-z]+$/i,
		capitals: /[A-Z]/g,
	},
	botIdTimeoutMs: 1000,
	flagTimeoutMs: 250,
	emailHashLength: 16,
	protect: [
		{ path: '/api/coursebuilder/subscribe-to-list/convertkit', method: 'POST' },
	],
}
