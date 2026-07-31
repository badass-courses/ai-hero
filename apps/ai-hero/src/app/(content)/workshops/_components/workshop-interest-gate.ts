import type { CtaGatingSubscriber } from '@/lib/cta-gating'

/**
 * Publish a confirmed workshop signup to every CTA using the shared gate query.
 * The synchronous write makes mounted UI (including the navbar) react now; the
 * background refresh verifies the optimistic value against the updated cookie.
 */
export function syncWorkshopInterestGate({
	gate,
	setGate,
	refreshGate,
}: {
	gate: CtaGatingSubscriber
	setGate: (gate: CtaGatingSubscriber) => void
	refreshGate: () => Promise<unknown>
}) {
	setGate(gate)
	void refreshGate().catch(() => undefined)
}
