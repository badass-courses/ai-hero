// Shared by the (learn) layout (a server component) and the wide-player
// client module, so it carries no 'use client' directive.

/** Where a viewer's wide-player choice is stored, per browser. */
export const LESSON_WIDE_KEY = 'aih.lesson-wide'

/** The attribute on <html> the (learn) layout uncaps on. */
export const LESSON_WIDE_ATTRIBUTE = 'data-lesson-wide'

// Runs inline in the (learn) layout before the capped container is parsed,
// so a page loaded wide paints wide and never jumps at hydration. Kept tiny
// and self-contained: it runs before any bundle.
export const LESSON_WIDE_BOOT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
	LESSON_WIDE_KEY,
)})==='1')document.documentElement.setAttribute(${JSON.stringify(
	LESSON_WIDE_ATTRIBUTE,
)},'')}catch(e){}`
