import type { ContactRecord } from '../src/lib/subscriber-marketing/types'

/** drovr's delivery payload carries the AI Hero contact id unchanged. */
export async function resolveRecoveryContact(
	input: { namespace: 'ai-hero' | 'drovr'; contactId: string },
	findContactById: (id: string) => Promise<ContactRecord | undefined>,
): Promise<ContactRecord | undefined> {
	const contact = await findContactById(input.contactId)
	return contact?.id === input.contactId ? contact : undefined
}
