# Web font subsetting

The site's three fonts (DM Sans, JetBrains Mono, Source Serif 4) are cut down to
what the site draws and split in two files each. Nothing here runs in the build:
run the scripts by hand and commit what they write.

- **Core** (`src/app/fonts/*-core-*.woff2`): ASCII, spaces, and the punctuation
  most pages use (`‘ ’ “ ” – — … · •`). Preloaded on every page, as the whole
  font was before.
- **Extended** (`src/app/fonts/*-ext-*.woff2`): every other character the
  original file has (Latin-1, `Œ œ ı`, `€ ™ ‹ ›`, arrows, combining marks).
  It joins the same family behind `unicode-range`, so it downloads only on a
  page that draws one of its characters.
- **`src/app/fonts/fonts.ts`**: the `next/font/local` calls, generated. The
  layout imports the core bindings from it.

Each file keeps the original's outlines, metrics, kerning and default-on
OpenType features. The weight axis loses only the part below 400, which no
`@font-face` rule can reach. Unused features (`frac`, `numr`, `dnom`, `pnum`,
`tnum`, `locl`) are dropped. The originals had no hinting to drop. Source Serif
is renamed "AIH Serif" inside the files, because the OFL reserves the name
"Source" for unmodified copies. The CSS family names don't change.

## Files

| file | what it is |
| --- | --- |
| `source/*.woff2` | The originals: Google's latin subsets, as the site served them before. The script's input. |
| `measure-usage.mjs` | Crawls rendered pages and writes `usage.json`: characters, weights, styles and features per face. |
| `usage.json` | The last crawl. |
| `subset.py` | Writes the woff2 files, `fonts.ts` and `manifest.json`, after checking every file against its original. |
| `manifest.json` | Sizes, glyph counts, `unicode-range`s and check results per file. |
| `pixel-diff.mjs`, `pixel-diff.py` | Before/after screenshots and their diffs. |

## Setup

```sh
cd apps/ai-hero
python3 -m venv scripts/fonts/.venv
scripts/fonts/.venv/bin/pip install -r scripts/fonts/requirements.txt
```

The Node scripts use the app's own Playwright (`pnpm exec playwright install chromium` if it has no browser).

## Rerun

```sh
cd apps/ai-hero
# 1. What the site draws now. Read-only against production, about 10 minutes.
node scripts/fonts/measure-usage.mjs https://www.aihero.dev
# 2. Cut the fonts. Fails, and writes nothing, if any file differs from its original.
scripts/fonts/.venv/bin/python scripts/fonts/subset.py
# 3. Prove it. Screenshots go to a scratch directory, never the repo.
node scripts/fonts/pixel-diff.mjs --out /tmp/font-diff
scripts/fonts/.venv/bin/python scripts/fonts/pixel-diff.py /tmp/font-diff
```

`subset.py --dry-run` checks and reports without writing. `pixel-diff.mjs
--after https://<preview-host>` compares production with a deployment instead
of swapping the fonts into production pages.

`pixel-diff.py` also compares each page with a second "before" capture. When
that noise column differs too, the page changed between loads (a different
height, live content) and that shot says nothing about the fonts: rerun it.

`subset.py` checks each file before writing it:

- **Shaping:** HarfBuzz shapes every character it serves, and every ordered
  pair, at weights 400 to 700 in both the file and the original. Outlines,
  advances and offsets must match exactly.
- **Rasterising:** FreeType rasterises every character with no hinting and
  with light autohinting, the setting Chrome on Linux uses for unhinted
  fonts. Core files must match bit for bit. An extended file may differ only
  in the characters `manifest.json` lists under `rasterDiffs`.
- **Metrics:** the vertical metrics must equal the original's, and so must the
  values `next/font` derives its fallback faces from.

## When to rerun

- **A font, weight range or style changes.** Edit `FAMILIES` in `subset.py`
  and keep its `weight` equal to the `@font-face` range.
- **CSS starts using an OpenType feature** through `font-feature-settings`,
  `font-variant-*` or a `lang` attribute. For example, `tabular-nums` on the
  serif, or `diagonal-fractions`. Add the feature to `FEATURES`.
- **Content starts drawing a character the fonts lack.** `subset.py` prints
  these as "used but not in font". They render in the fallback font, as they
  did before this split. Adding one means taking it from the upstream font,
  which changes how it looks.
- **A character outside the core shows up on most pages.** Add it to
  `CORE_PUNCTUATION`, so those pages don't fetch an extended file for it.
- **Next.js changes how `next/font` names families.** Turbopack names a
  `next/font/local` family after its binding (`geist`). The extended calls
  declare that name, so check that the built CSS still gives both calls'
  `@font-face` rules the same `font-family`.

## Known differences

All of these happen only on pages that draw an extended character. The last
crawl found none in the sans or serif text (one page draws `é` in mono, and a
few draw `£`, `°` or `²`).

- **Kerning across the split.** A browser shapes each file separately, so a
  kerning pair with one character in each file loses its kerning: `T` next to
  `é`, for example. DM Sans has about 1,900 such pairs and Source Serif about
  5,500. `subset.py --core-latin1-letters` moves `À`–`ÿ` into the core, which
  keeps most of these pairs and adds about 21 KB to every page's preload.
- **Decomposed accents.** A combining mark (`e` followed by U+0301, as some
  macOS input produces) can't attach to a base letter in the other file. That
  cluster renders in the fallback font. Moving the marks into the core costs
  about 8 KB per page.
- **`↑ ↓` in DM Sans under Linux autohinting.** They snap differently because
  the extended file lacks the ASCII glyphs the autohinter measures them
  against. Copying all of ASCII into the extended file to fix it would add
  12 KB to it.
