import type { Adapter } from '@auth/core/adapters'

import type { AuthStoragePort } from '@coursebuilder/core/auth'
import type { IdentityPort } from '@coursebuilder/core/ports'

/** Auth.js binding owned by this application boundary. */
export function createAuthJsAdapter(
	storage: AuthStoragePort & IdentityPort,
): Adapter {
	return storage as Adapter
}
