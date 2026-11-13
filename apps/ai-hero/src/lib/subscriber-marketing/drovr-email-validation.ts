import { z } from 'zod'

const rejectReason = z.enum([
	'syntax',
	'disposable_domain',
	'no_mail_exchanger',
	'bounced',
	'complained',
])
const fields = {
	email: z.string(),
	policyVersion: z.string(),
	suggestion: z.string().optional(),
}
const reply = z.discriminatedUnion('verdict', [
	z.object({ ...fields, verdict: z.literal('accept') }),
	z.object({ ...fields, verdict: z.literal('reject'), reason: rejectReason }),
])

type WithoutEmail<T> = T extends unknown ? Omit<T, 'email'> : never
type Validation = WithoutEmail<z.infer<typeof reply>>
export type DrovrEmailValidation =
	| Validation
	| { verdict: 'unknown'; error: string; httpStatus?: number }

/** A bounded, no-retry signup check. Provider failures never block login. */
export async function validateEmailWithDrovr(
	email: string,
	config?: { baseUrl?: string; apiKey?: string; fetch?: typeof fetch },
): Promise<DrovrEmailValidation> {
	if (!config?.baseUrl || !config.apiKey)
		return { verdict: 'unknown', error: 'missing_config' }
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			(async (): Promise<DrovrEmailValidation> => {
				const response = await (config.fetch ?? fetch)(
					`${config.baseUrl!.replace(/\/$/, '')}/email-validations`,
					{
						method: 'POST',
						headers: {
							authorization: `Bearer ${config.apiKey}`,
							'content-type': 'application/json',
						},
						body: JSON.stringify({ email }),
						signal: controller.signal,
						cache: 'no-store',
					},
				)
				if (!response.ok)
					return {
						verdict: 'unknown',
						error: 'http_error',
						httpStatus: response.status,
					}
				// A 2xx whose body is not a verdict is drovr's fault, not the network's.
				const parsed = reply.safeParse(await response.json().catch(() => null))
				if (!parsed.success) return { verdict: 'unknown', error: 'bad_body' }
				const { email: checkedEmail, ...result } = parsed.data
				if (checkedEmail !== email.trim().toLowerCase())
					return { verdict: 'unknown', error: 'email_mismatch' }
				return result
			})(),
			new Promise<DrovrEmailValidation>((resolve) => {
				timer = setTimeout(() => {
					controller.abort()
					resolve({ verdict: 'unknown', error: 'timeout' })
				}, 800)
			}),
		])
	} catch {
		// Do not return provider error text: it may contain the submitted address.
		return { verdict: 'unknown', error: 'request_failed' }
	} finally {
		clearTimeout(timer)
	}
}
