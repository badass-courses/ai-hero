-- Read-only detector for completed paid Stripe checkout sessions that still
-- have no Purchase after a 15 minute processing window.
-- This query performs no writes. Keep LIMIT bounded for operator use.
WITH paid_checkout_events AS (
	SELECT
		e.identifier AS stripe_event_id,
		JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.id')) AS checkout_session_id,
		e.createdAt AS received_at
	FROM AI_MerchantEvents AS e
	WHERE JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.type')) = 'checkout.session.completed'
		AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.mode')) = 'payment'
		AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.status')) = 'complete'
		AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.data.object.payment_status')) = 'paid'
		AND e.createdAt < CURRENT_TIMESTAMP - INTERVAL 15 MINUTE
)
SELECT
	pce.stripe_event_id,
	pce.checkout_session_id,
	pce.received_at,
	COUNT(DISTINCT ms.id) AS merchant_session_count,
	COUNT(DISTINCT p.id) AS purchase_count
FROM paid_checkout_events AS pce
LEFT JOIN AI_MerchantSession AS ms
	ON ms.identifier = pce.checkout_session_id
LEFT JOIN AI_Purchase AS p
	ON p.merchantSessionId = ms.id
GROUP BY
	pce.stripe_event_id,
	pce.checkout_session_id,
	pce.received_at
HAVING COUNT(DISTINCT p.id) = 0
ORDER BY pce.received_at ASC
LIMIT 100;
