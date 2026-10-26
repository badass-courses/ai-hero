import { AsyncLocalStorage } from 'node:async_hooks'

const proxyAuthContext = new AsyncLocalStorage<true>()

/**
 * Run the proxy's `auth()` call. Inside it, the session callback defers slow
 * side work (an expired Discord token refresh) until after the response.
 */
export function runInProxyAuthContext<T>(operation: () => T): T {
	return proxyAuthContext.run(true, operation)
}

export function isInProxyAuthContext() {
	return proxyAuthContext.getStore() === true
}
