import { guid } from '@coursebuilder/utils/guid'

/** Creates a local database ID without changing public identifier formats. */
export function createInternalId() {
	return guid(12)
}
