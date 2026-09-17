import { revalidateTag } from 'next/cache'

/**
 * Every product write ends here.
 *
 * Which products exist, whether they are live, what type they are, and which
 * resources they carry all feed "the newest buyable workshop"
 * (`getCachedLatestSelfPacedWorkshop`) and the offer ladder (`next-offer`)
 * behind the nav and `/courses`. Both are tagged `products`, so one tag
 * covers a create, an update, an archive, and an attach or detach alike.
 * Without it the old answer stayed cached for up to an hour after the change.
 */
export function revalidateProducts() {
	revalidateTag('products', 'max')
}
