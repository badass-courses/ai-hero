import type { PublicStatus } from "../contracts/index";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function statusPage(status: PublicStatus): string {
  const label =
    status.overall === "unknown"
      ? "Status checks are not armed"
      : status.overall === "operational"
        ? "All systems operational"
        : `AI Hero is ${status.overall}`;
  const incidents =
    status.incidents.length === 0
      ? status.overall === "unknown"
        ? "<p>No status result is available yet.</p>"
        : "<p>No active incidents.</p>"
      : status.incidents
          .map(
            (incident) =>
              `<article><h2>${escapeHtml(incident.title)}</h2><p>${escapeHtml(incident.summary)}</p><small>Updated ${escapeHtml(incident.updatedAt)}</small></article>`,
          )
          .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>AI Hero Status</title>
  <style>
    :root { color-scheme: light dark; font: 17px/1.55 system-ui, sans-serif; }
    body { margin: 0; padding: 2rem 1rem; }
    main { max-width: 42rem; margin: 0 auto; }
    h1 { font-size: clamp(2rem, 7vw, 3.5rem); line-height: 1.05; }
    .state { padding: 1rem; border: 2px solid currentColor; border-radius: .75rem; font-weight: 700; }
    article { margin-top: 2rem; }
  </style>
</head>
<body><main><p>AI Hero</p><h1>Status</h1><p class="state">${escapeHtml(label)}</p>${incidents}</main></body>
</html>`;
}

export function unavailablePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>AI Hero Status</title></head><body><main><h1>Status temporarily unavailable</h1><p>We cannot load the latest status. This page does not claim that AI Hero is operational.</p></main></body></html>`;
}
