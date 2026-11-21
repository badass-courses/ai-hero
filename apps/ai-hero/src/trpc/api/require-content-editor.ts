import { TRPCError } from '@trpc/server'

/**
 * Throws FORBIDDEN unless the caller can create Content.
 *
 * protectedProcedure only proves a login, and anyone can sign up by magic link.
 * Reminder and workshop email procedures read purchaser names and emails, edit
 * shared email records and send to every purchaser, so they need an editor
 * (security desk, 2026-11-20, extending sec-20261111-003).
 */
export function requireContentEditor(ctx: {
	ability: { can: (action: 'create', subject: 'Content') => boolean }
}) {
	if (!ctx.ability.can('create', 'Content')) {
		throw new TRPCError({ code: 'FORBIDDEN' })
	}
}
