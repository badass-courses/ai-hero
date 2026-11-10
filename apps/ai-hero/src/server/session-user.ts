import { z } from 'zod'

import { userSchema } from '@coursebuilder/core/schemas'

/**
 * The session user, with email as a plain string. Core's userSchema demands
 * a valid-looking email, and about 200 stored accounts (double dots, spaces,
 * older OAuth emails) fail it. Parsing with it threw on every tRPC call for
 * those learners, so a signed-in session broke the whole site for them.
 * The account is already authenticated; its email format is not ours to
 * enforce here.
 */
export const sessionUserSchema = userSchema.extend({
	email: z.string().max(255),
})

const strictEmail = z.string().max(255).email()

export type SessionUserParse = {
	user: z.infer<typeof sessionUserSchema> | null | undefined
	/** True when the stored email fails the strict email check. */
	invalidEmail: boolean
}

export function parseSessionUser(input: unknown): SessionUserParse {
	const user = sessionUserSchema.optional().nullable().parse(input)
	const invalidEmail = Boolean(user) && !strictEmail.safeParse(user?.email).success
	return { user, invalidEmail }
}
