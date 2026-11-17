// Shared by the (learn) layout (a server component) and the player host,
// so it carries no 'use client' directive.

/** Where a viewer's choice to hide the session panel is stored, per browser. */
export const SESSION_PANEL_HIDDEN_KEY = 'aih.session-panel-hidden'

/** The attribute on <html> that hides the session panel and its strip. */
export const SESSION_PANEL_HIDDEN_ATTRIBUTE = 'data-session-panel-hidden'

// Runs inline in the (learn) layout before the lesson is parsed, so a viewer
// who hid the panel never sees it, or its strip under the player, flash and
// then vanish at hydration (the strip would move the lesson text). Kept tiny
// and self-contained: it runs before any bundle.
export const SESSION_PANEL_BOOT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
	SESSION_PANEL_HIDDEN_KEY,
)})==='1')document.documentElement.setAttribute(${JSON.stringify(
	SESSION_PANEL_HIDDEN_ATTRIBUTE,
)},'')}catch(e){}`
