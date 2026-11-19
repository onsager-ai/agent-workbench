# Agent Workbench identity

<img src="agent-workbench-mark-light.svg" width="96" height="96" alt="Agent Workbench">

One Manager square sits above three Worker squares, on the 32 × 32 grid used by the other onsager-ai marks.

| Element | x | y | Width | Height |
| --- | --- | --- | --- | --- |
| Manager (shared centre) | 11 | 11 | 10 | 10 |
| Left Worker | 2 | 26 | 4 | 4 |
| Middle Worker | 14 | 26 | 4 | 4 |
| Right Worker | 26 | 26 | 4 | 4 |

## Why this form

Agent Workbench runs work as one user-facing Manager session that delegates to Worker subagents. The mark draws that directly.

- **The centre** is the Manager. It uses the same 10 × 10 square at (11, 11) as Duhem, Ostrom, Semon and Tolmap.
- **The three squares** are Workers. Each is one family stroke (4 units) on a side and sits 5 units below the centre, the same gap the other marks use between centre and surround.
- **The open top and sides** separate it from the closed or bracketing forms of the sibling marks. The Manager reports only to the user, so nothing frames it from above.

## Files

| File | Use |
| --- | --- |
| `agent-workbench-mark.svg` | Master mark, `currentColor`. Use inline. |
| `agent-workbench-mark-{light,dark}.svg` | Fixed `#111111` / `#FFFFFF` mark for `<img>` on light / dark backgrounds. |
| `agent-workbench-wordmark.svg` | Outlined Inter Regular wordmark, `currentColor`. |
| `agent-workbench-lockup.svg` | Horizontal lockup, `currentColor`. |
| `agent-workbench-lockup-{light,dark}.{svg,png}` | Fixed-colour lockups for READMEs and pages, where `currentColor` is not inherited. |
| `favicon.svg` | Vertically centred mark that switches to white under `prefers-color-scheme: dark`. |
| `favicon.ico` | 16, 32 and 48 px PNG entries. |
| `agent-workbench-{16,32,48,64,192,512}.png` | Vertically centred black mark on transparency. |
| `agent-workbench-app-icon.png` | 1024 px white mark on the shared navy `#1E3A5F` rounded plate. |
| `agent-workbench-apple-touch-icon.png` | 180 px opaque square of the app icon for iOS. |
| `social-preview.png` | 1280 × 640 GitHub social preview. Upload it in the repository's settings. |
| `Inter-OFL.txt` | Licence for the outlined wordmark font. |

## Rules

- The mark is monochrome. Do not add gradients, shadows or rotation, and do not colour the Manager differently from the Workers.
- The mark keeps the family canvas, so its ink sits in the lower two-thirds of the 32 × 32 box. Favicons, icon PNGs, the app icons and the social preview centre the visible ink instead, so they sit level with other icons in tabs and launchers.
- Leave clear space of at least half the canvas width around a standalone mark. The minimum size is a 16 px canvas.
- In the lockup, the visible mark runs from the wordmark's cap height to its baseline, and the gap is one scaled 4-unit stroke.
- At 16 px and 48 px the scale is fractional, so the generator uses hand-snapped whole-pixel grids there. It checks that every raster mark is mirror-symmetric and fails if one is not.

## Regenerating

```sh
cd docs/brand
npm install
npm run generate
```

`generate.mjs` is the source of truth and its output is byte-for-byte deterministic. Edit the geometry there, never the generated files. Its dependencies (`opentype.js`, `wawoff2`, `@fontsource/inter`, `@resvg/resvg-js`) are build-time only and stay in this directory.

## References

- [Duhem brand kit](https://github.com/onsager-ai/duhem/tree/main/assets/brand)
- [Ostrom mark](https://github.com/onsager-ai/ostrom/tree/main/docs/brand)
- [Tolmap identity](https://github.com/onsager-ai/tolmap/tree/main/docs/design/brand)
