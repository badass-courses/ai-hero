import type { PricingPolicyData } from '@ai-hero/front-desk-support/pricing'
import { checkoutStopsAt, enrollmentClosesAt } from './decision'
import { MIN_CHECKOUT_TTL_SECONDS } from './gift-slots'

/** One policy creation cutoff; an earlier code deadline still respects Stripe's floor. */
export function giftCheckoutOpen(expiresAt: string, policy: PricingPolicyData | null, now: number) {
  if (!policy?.enabled) return false
  const stop = checkoutStopsAt(policy), enrollment = enrollmentClosesAt(policy)
  if (stop === undefined || enrollment === undefined || now >= stop) return false
  return Math.min(Date.parse(expiresAt), enrollment) - now >= MIN_CHECKOUT_TTL_SECONDS * 1000
}
