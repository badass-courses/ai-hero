import 'server-only'

import { courseBuilderAdapter } from '@/db'

/**
 * Read a transfer by id. The id is an unguessable capability delivered to
 * the target by email; the invite page needs it before the target signs
 * in, so there is deliberately no session requirement here. Mutations all
 * re-check identity server-side.
 */
export async function getPurchaseTransferById(input: { id: string }) {
	return await courseBuilderAdapter.getPurchaseUserTransferById({
		id: input.id,
	})
}
