import type { ContactRecord } from '../src/lib/subscriber-marketing/types'

/** drovr's delivery payload carries the AI Hero contact id unchanged. */
export async function resolveRecoveryContact(
	input: { namespace: 'ai-hero' | 'drovr'; contactId: string },
	findContactById: (id: string) => Promise<ContactRecord | undefined>,
): Promise<ContactRecord | undefined> {
	throw new Error('Recovery identity resolver is not implemented')
}
