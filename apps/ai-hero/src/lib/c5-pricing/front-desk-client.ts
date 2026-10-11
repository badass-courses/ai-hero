import 'server-only'
import { env } from '@/env.mjs'
import { createFrontDeskData, type FrontDeskData } from './front-desk-data'

let data: FrontDeskData | null | undefined
/** Read transport only: no hook, flag or cookie imports. */
export function frontDeskData(): FrontDeskData | null {
  if (data === undefined) data = env.FRONT_DESK_URL && env.FRONT_DESK_PRICING_TOKEN
    ? createFrontDeskData({ url: env.FRONT_DESK_URL, pricingToken: env.FRONT_DESK_PRICING_TOKEN, quotesToken: env.FRONT_DESK_QUOTES_TOKEN })
    : null
  return data
}
