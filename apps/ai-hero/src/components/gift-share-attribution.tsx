'use client'

import { useEffect } from 'react'
import { rememberGiftShare } from '@/lib/c5-pricing/gift-attribution'

export function GiftShareAttribution({ slug }: { slug: string }) {
  useEffect(() => { void rememberGiftShare(slug).catch(() => undefined) }, [slug])
  return null
}
