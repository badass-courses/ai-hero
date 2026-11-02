/**
 * Lesson images that stay images: screenshots, photos, anything that is not
 * one of Matt's drawings. Keyed like the redraws, by Cloudinary public id, so
 * course sync stops asking for a redraw of them.
 */
export const notDrawings: ReadonlySet<string> = new Set<string>([])
