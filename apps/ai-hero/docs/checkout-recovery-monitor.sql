-- Read-only detector for completed paid Stripe checkout sessions that still
-- have no Purchase after a 15 minute processing window.
-- This query performs no writes. Keep LIMIT bounded for operator use.
WITH paid_checkout_events AS (
	SELECT
		e.identifier AS stripe_event_id,
		JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.id')) AS checkout_session_id,
		COALESCE(
			JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.payment_intent.id')),
			JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.payment_intent'))
		) AS payment_intent_id,
		e.createdAt AS received_at
	FROM AI_MerchantEvents AS e
	WHERE JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.type')) = 'checkout.session.completed'
		AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.mode')) = 'payment'
		AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.status')) = 'complete'
		AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.payment_status')) = 'paid'
		AND e.createdAt < CURRENT_TIMESTAMP - INTERVAL 15 MINUTE
),
charge_events AS (
	SELECT
		JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.id')) AS stripe_charge_id,
		COALESCE(
			JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.payment_intent.id')),
			JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.payment_intent'))
		) AS payment_intent_id
	FROM AI_MerchantEvents AS e
	WHERE JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.type')) = 'charge.succeeded'
)
SELECT
	pce.stripe_event_id,
	pce.checkout_session_id,
	pce.received_at,
	COUNT(DISTINCT ms.id) AS merchant_session_count,
	COUNT(DISTINCT mc.id) AS merchant_charge_count,
	COUNT(DISTINCT purchase_by_session.id) AS session_purchase_count,
	COUNT(DISTINCT purchase_by_charge.id) AS charge_purchase_count
FROM paid_checkout_events AS pce
LEFT JOIN AI_MerchantSession AS ms
	ON ms.identifier = pce.checkout_session_id
LEFT JOIN AI_Purchase AS purchase_by_session
	ON purchase_by_session.merchantSessionId = ms.id
LEFT JOIN charge_events AS ce
	ON ce.payment_intent_id = pce.payment_intent_id
LEFT JOIN AI_MerchantCharge AS mc
	ON mc.identifier = ce.stripe_charge_id
LEFT JOIN AI_Purchase AS purchase_by_charge
	ON purchase_by_charge.merchantChargeId = mc.id
GROUP BY
	pce.stripe_event_id,
	pce.checkout_session_id,
	pce.received_at
HAVING COUNT(DISTINCT purchase_by_session.id) = 0
	AND COUNT(DISTINCT purchase_by_charge.id) = 0
ORDER BY pce.received_at ASC
LIMIT 100;
