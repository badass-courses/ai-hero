// Customer identifiers never enter support memory (Switchboard ruling relayed
// by switchboard/ea 3n2trtfkymxlk, 2026-11-21, after the security desk found
// /api/memory readable without login, sec-032). Harm guarded: customer emails
// and Front ids exposed to anyone who can read the store.
//
// Mirrors aihero-support `.pi/extensions/support-memory/redact.ts` (PR #173),
// the other writer, so both paths store the same text.

/** Our own sending domains stay readable: operator facts, not customer data. */
export const OWN_EMAIL_DOMAINS = [
	'aihero.dev',
	'badass.dev',
	'skillrecordings.com',
	'totaltypescript.com',
	'egghead.io',
	'codetv.dev',
]

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g
const FRONT_CONVERSATION = /\bcnv_[a-z0-9]+\b/gi
const FRONT_MESSAGE = /\bmsg_[a-z0-9]+\b/gi

/** Notes about individual customers. Names slip past the email and id rules. */
export const REFUSED_MEMORY_CATEGORIES = ['customer-context'] as const

export type Redaction = { text: string; removed: number }

function isOwnDomain(domain: string): boolean {
	const d = domain.toLowerCase()
	return OWN_EMAIL_DOMAINS.some((own) => d === own || d.endsWith(`.${own}`))
}

export function redactCustomerIdentifiers(input: string): Redaction {
	let removed = 0
	const text = input
		.replace(EMAIL, (match, domain: string) => {
			if (isOwnDomain(domain)) return match
			removed += 1
			return '[customer email]'
		})
		.replace(FRONT_CONVERSATION, () => {
			removed += 1
			return '[conversation]'
		})
		.replace(FRONT_MESSAGE, () => {
			removed += 1
			return '[message]'
		})
	return { text, removed }
}
