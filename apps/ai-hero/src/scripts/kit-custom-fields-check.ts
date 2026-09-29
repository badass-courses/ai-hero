import { pathToFileURL } from 'node:url'

/**
 * Read-only: does AI Hero's Kit account have these custom fields? One
 * `GET /v3/custom_fields`; it never creates or writes a field. Prints field
 * keys and yes/no, never a value or the API key. Exits 1 when any is missing.
 *
 *   pnpm kit:fields:check                       # the row 183 fields
 *   pnpm kit:fields:check aih_some_other_field  # any keys
 *   pnpm kit:fields:check --email <test address> # one subscriber's values
 *
 * `--email` is for the post-flip check on a TEST address only: one
 * `GET /v3/subscribers?email_address=`, printing the evidence field and
 * whether the attribution stash is set. Still no writes.
 *
 * Needs CONVERTKIT_API_KEY (and CONVERTKIT_API_SECRET for --email) in the
 * environment, e.g. DOTENV_CONFIG_PATH=<checkout>/apps/ai-hero/.env.vercel.
 */

export const ROW_183_KIT_FIELDS = [
	// Written at signup once AIH_DEADLINE_TIMEZONE_CAPTURE_ENABLED is on.
	'aih_course_entry_evidence',
	// Written at coupon issue; the long one exists today.
	'aih_evergreen_deadline_display',
	// Written at coupon issue once AIH_EVERGREEN_DEADLINE_FORMAT_V2_ENABLED is on.
	'aih_evergreen_deadline_short',
] as const

export async function checkKitCustomFields(args: {
	apiKey: string
	keys: readonly string[]
	fetcher?: typeof fetch
}): Promise<Record<string, boolean>> {
	const url = new URL('https://api.convertkit.com/v3/custom_fields')
	url.searchParams.set('api_key', args.apiKey)
	const response = await (args.fetcher ?? fetch)(url, { method: 'GET' })
	if (!response.ok)
		throw new Error(`Kit custom_fields read failed: HTTP ${response.status}`)
	const body = (await response.json()) as {
		custom_fields?: Array<{ key?: unknown }>
	}
	const existing = new Set(
		(body.custom_fields ?? []).flatMap((field) =>
			typeof field.key === 'string' ? [field.key] : [],
		),
	)
	return Object.fromEntries(args.keys.map((key) => [key, existing.has(key)]))
}

export async function readSubscriberRow183Fields(args: {
	apiSecret: string
	email: string
	fetcher?: typeof fetch
}): Promise<
	| { found: false }
	| { found: true; courseEntryEvidence: string | null; attributionStashed: boolean }
> {
	const url = new URL('https://api.convertkit.com/v3/subscribers')
	url.searchParams.set('api_secret', args.apiSecret)
	url.searchParams.set('email_address', args.email.trim().toLowerCase())
	const response = await (args.fetcher ?? fetch)(url, { method: 'GET' })
	if (!response.ok)
		throw new Error(`Kit subscriber read failed: HTTP ${response.status}`)
	const body = (await response.json()) as {
		subscribers?: Array<{ fields?: Record<string, string | null> }>
	}
	const fields = body.subscribers?.[0]?.fields
	if (!fields) return { found: false }
	return {
		found: true,
		courseEntryEvidence: fields.aih_course_entry_evidence ?? null,
		attributionStashed: Boolean(fields.aih_optin_attribution),
	}
}

const secretFromEnv = (name: string) => {
	const value = process.env[name]?.trim()
	if (!value || value === '[SENSITIVE]')
		throw new Error(`${name} is missing or a Vercel placeholder`)
	return value
}

async function main() {
	const emailFlag = process.argv.indexOf('--email')
	if (emailFlag !== -1) {
		const email = process.argv[emailFlag + 1]
		if (!email) throw new Error('--email needs a test address')
		console.log(
			JSON.stringify(
				await readSubscriberRow183Fields({
					apiSecret: secretFromEnv('CONVERTKIT_API_SECRET'),
					email,
				}),
				null,
				2,
			),
		)
		return
	}
	const apiKey = secretFromEnv('CONVERTKIT_API_KEY')
	const keys = process.argv.slice(2)
	const result = await checkKitCustomFields({
		apiKey,
		keys: keys.length > 0 ? keys : ROW_183_KIT_FIELDS,
	})
	for (const [key, exists] of Object.entries(result))
		console.log(`${key}: ${exists ? 'yes' : 'NO'}`)
	if (Object.values(result).some((exists) => !exists)) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 2
	})
}
