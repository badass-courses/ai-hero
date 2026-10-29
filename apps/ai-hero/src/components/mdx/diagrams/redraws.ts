import type * as React from 'react'

/**
 * Images redrawn in code, keyed by the Cloudinary public id of the image they
 * replace (`ai-hero-images/<id>`). Each value draws that one image: the same
 * drawing, in the state it was in when Matt grabbed that frame.
 */
export type Redraws = Readonly<Record<string, () => React.ReactNode>>
