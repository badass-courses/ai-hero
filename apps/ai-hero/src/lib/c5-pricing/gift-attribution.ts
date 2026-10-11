'use server'

import { cookies } from 'next/headers'
import { db } from '@/db'
import { giftShareLink } from '@/db/schema'
import { eq } from 'drizzle-orm'

/** A copied via URL keeps attribution, but can never issue the gift cookie. */
export async function rememberGiftShare(slug: string): Promise<boolean> {
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,50}$/.test(slug)) return false
  try {
    const [link] = await db.select({ slug: giftShareLink.slug }).from(giftShareLink).where(eq(giftShareLink.slug, slug)).limit(1)
    if (!link) return false
    ;(await cookies()).set('sl_ref', slug, {
      maxAge: 60 * 60 * 24 * 30, path: '/', httpOnly: true,
      sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    })
    return true
  } catch { return false }
}
