/**
 * Literal prompts for every refusal the support transfer endpoint returns with
 * a 409. Each says what happened and what to do next; nothing was changed.
 * Keyed by the same reason string the endpoint returns.
 */
export const SUPPORT_TRANSFER_REFUSAL_PROMPTS = {
	// support-initiate
	invalid_email: 'Refused: targetEmail is not a valid email address. Fix it and send again.',
	purchase_missing: 'Refused: no purchase with that purchaseId. Check the id and send again.',
	not_purchase_owner: 'Refused: sourceUserId does not hold this purchase. Use the current holder as sourceUserId.',
	purchase_not_valid: 'Refused: the purchase is not Valid (refunded or restricted). Do not move it.',
	same_user: 'Refused: targetEmail belongs to the account that already holds the purchase. Nothing to move.',
	transfer_in_flight: 'Refused: another transfer for this purchase is already in flight. Wait for it to finish or cancel it first.',
	transfer_slot_missing: 'Refused: this purchase has no open transfer slot for the holder. Ask the holder to open one, then send again.',
	transfer_slot_expired: 'Refused: the transfer slot has expired. Ask the holder for a fresh one, then send again.',
	transfer_race_lost: 'Refused: another request claimed this transfer first. Check its state before sending again.',
	// support-complete
	transfer_not_found: 'Refused: no transfer with that transferId. Check the id and send again.',
	transfer_identity_mismatch: 'Refused: transferId does not belong to this purchaseId and sourceUserId. Use the ids from the same transfer.',
	transfer_target_missing: 'Refused: the transfer has no target account yet. Send the invite first.',
	transfer_expired: 'Refused: the transfer has expired. Start a new transfer.',
	transfer_not_completable: 'Refused: the transfer is in a state that cannot be completed (canceled or expired). Start a new transfer.',
	purchase_not_found: 'Refused: the purchase for this transfer was not found. Escalate to engineering.',
	transfer_user_missing: 'Refused: the source or target account is missing. Escalate to engineering.',
	target_email_mismatch: 'Refused: targetEmail does not match the transfer\'s target account. Use the address the invite went to.',
	same_user_transfer: 'Refused: source and target are the same account. Nothing to move.',
	team_purchase_not_supported: 'Refused: team purchases and redeemed seats cannot be moved this way. Hand it to engineering.',
	source_no_longer_owns_purchase: 'Refused: sourceUserId no longer holds the purchase. Re-check the current holder.',
	verified_owner_mismatch: 'Refused: the purchase is not held by the transfer\'s target. Escalate to engineering.',
	conflicting_transfer: 'Refused: another open transfer exists for this purchase. Resolve or cancel it first.',
	destination_already_owns_product: 'Refused: the target account already owns this product. Do not move it.',
	destination_already_has_access: 'Refused: the target account already has access to this product. Do not move it.',
	billing_charge_missing: 'Refused: the purchase has no billing charge to keep with its payer. Escalate to engineering.',
	move_would_leave_charge_without_payer: 'Refused: the move would leave the charge with no payer. Escalate to engineering.',
	move_would_change_invoice_payer: 'Refused: this move would change who the invoice payer is. A plain move never does. If both accounts are the same person, resend with samePerson evidence.',
	refund_present: 'Refused: Stripe shows a refund on this charge. Do not move a refunded purchase.',
	charge_deleted: 'Refused: the Stripe charge no longer exists. Escalate to engineering.',
	refund_state_unverifiable: 'Refused: Stripe refund state could not be read. Try again in a minute; if it repeats, escalate.',
	outbox_missing: 'Pending: the move is recorded but its event is missing. Escalate to engineering; do not resend.',
	event_publish_failed: 'Pending: the move is recorded but the access event did not publish. Send support_complete_status later; do not resend.',
	same_person_evidence_invalid: "Refused: samePerson needs verifiedBy ('owner-mailbox-both' or 'same-stripe-customer'), a reason up to 1000 characters, and a proofRef up to 255 characters with no @ in it. Fix all three or remove samePerson.",
	same_person_table_missing: 'Refused: the same-person table is not deployed yet, so nothing was moved. Ask engineering to apply the migration, then send again.',
	same_person_source_not_payer: 'Refused: sourceUserId is not the current invoice payer, so a same-person move would change nothing. Remove samePerson for a plain move, or name the payer as sourceUserId.',
	same_person_move_did_not_apply: 'Refused: the checks passed but the same-person move would not make the target the payer. This should not happen. Escalate to the desk; do not resend.',
	same_person_order_unknown: 'Refused: an earlier completed transfer on this purchase has no date, so the payer chain cannot be ordered. Escalate to engineering; do not resend.',
	same_person_cannot_be_added_after_claim: 'Refused: this transfer was already claimed without samePerson, and evidence cannot be added afterwards. Remove samePerson to finish the plain move.',
} as const

export type SupportTransferRefusalReason =
	keyof typeof SUPPORT_TRANSFER_REFUSAL_PROMPTS

export function supportTransferRefusalPrompt(reason: string): string {
	return (
		(SUPPORT_TRANSFER_REFUSAL_PROMPTS as Record<string, string>)[reason] ??
		`Refused: ${reason}. Nothing was changed. Escalate to engineering with this reason.`
	)
}
