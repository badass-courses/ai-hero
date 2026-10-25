/** Stripe uses ch_ for card charges and py_ for non-card charges. */
export function isStripeChargeId(id: string | null | undefined): id is string {
	return (
		typeof id === 'string' && (id.startsWith('ch_') || id.startsWith('py_'))
	)
}
