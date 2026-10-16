/**
 * AI Hero checkout is USD-only. There is no exported commerce currency setting:
 * @coursebuilder/commerce/src/resolve-checkout-price.ts:62 requires `usd`;
 * src/stripe-checkout.ts:665,1084,1151,1212 uses `currency: 'USD'`.
 * Legacy AI_Price.fields is empty, so it is not a currency/activation authority.
 * Used only by Product and Course JSON-LD; never changes checkout configuration.
 */
export const JSON_LD_CURRENCY = 'USD'
