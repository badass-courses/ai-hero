import { AsyncLocalStorage } from 'node:async_hooks'

const storage = new AsyncLocalStorage<{
	preSessionId: string | null
	decisionKind: string | null
}>()
export async function withCheckoutTelemetry<T>(
	preSessionId: string | null,
	run: () => Promise<T>,
) {
	const context = { preSessionId, decisionKind: null as string | null }
	const value = await storage.run(context, run)
	return { value, decisionKind: context.decisionKind }
}
export function recordCheckoutDecision(kind: string) {
	const context = storage.getStore()
	if (context) context.decisionKind = kind
	return context?.preSessionId ?? null
}
