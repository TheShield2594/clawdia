# The canvas backend

Everything the bot draws — welcome and rank cards, war and wealth banners,
achievement toasts, the season recap, pet sprites, shop banners, the 8-ball
image, `/caption`, `/wanted`, `/wasted` — goes through one dependency:
[`canvas`](https://www.npmjs.com/package/canvas) (node-canvas), a Cairo/Pango
binding compiled from source.

This page records what that costs, what the measured alternative is, and what
would have to be true before swapping. It exists because the question keeps
coming back (#933) and answering it properly takes a day of measurement that
should not be repeated from scratch each time.

## What node-canvas costs today

It is the only dependency in the tree that needs a compiler. `Dockerfile`'s
build stage installs eleven packages purely to satisfy it:

```
cairo-dev  jpeg-dev  pango-dev  giflib-dev  pixman-dev  pangomm-dev
libjpeg-turbo-dev  freetype-dev  python3  make  g++
```

and the runtime stage installs six shared libraries for the same binary to link
against at run time (`cairo`, `jpeg`, `pango`, `giflib`, `pixman`, `freetype`).
The two lists have to stay in step by hand: a package added to one and not the
other produces an image that installs cleanly and throws on the first generated
card, which is the failure `scripts/image-smoke.js` exists to catch.

npm publishes prebuilt binaries for node-canvas, but glibc only. The image is
Alpine, so none of them apply and every build compiles the whole thing — which
is also why `canvas` is the dependency most likely to break on a Node major
bump, since a new ABI means a new compile against whatever Cairo the base image
happens to ship.

None of this is a runtime problem. Rendering is main-thread work capped at two
concurrent renders by `src/utils/cardRenderQueue.js`, and the PNG encode is
already off the event loop via the callback form of `toBuffer` (see
`src/utils/canvasEncode.js` and #592). The cost is build fragility and image
build time, and it is paid at upgrade time rather than in production.

## The alternative: @napi-rs/canvas

[`@napi-rs/canvas`](https://www.npmjs.com/package/@napi-rs/canvas) is a Skia
binding shipped as prebuilt N-API binaries — including `linux-x64-musl` and
`linux-arm64-musl`, which is the pair Alpine needs. Adopting it would delete
the compiler and both apk lists above outright, and being N-API it would also
make moving card rendering onto worker threads possible later.

Everything below was measured against `@napi-rs/canvas@1.0.8` and
`canvas@3.2.3` on Node 22, driving this repo's own `src/utils/cardGenerator.js`
through both backends behind a two-line compatibility shim.

### API compatibility: good, with two required changes

Every 2D context call the repo makes is supported unchanged. The full set in
use is `arc`, `arcTo`, `beginPath`, `bezierCurveTo`, `clip`, `closePath`,
`createLinearGradient`, `createRadialGradient`, `drawImage`, `ellipse`, `fill`,
`fillRect`, `fillStyle`, `fillText`, `font`, `getImageData`, `lineCap`,
`lineTo`, `lineWidth`, `measureText`, `moveTo`, `putImageData`, `restore`,
`save`, `scale`, `shadowBlur`, `shadowColor`, `stroke`, `strokeRect`,
`strokeStyle`, `strokeText`, `textAlign`, `textBaseline`, `translate`.

Two module-level APIs differ, and both are used here:

| Used today | On `@napi-rs/canvas` | Site |
|---|---|---|
| `registerFont(file, { family, weight })` | `GlobalFonts.registerFromPath(file, family)` | `src/utils/registerFonts.js` |
| `canvas.toBuffer(callback, mime)` | `canvas.encode('png')` (returns a Promise) | `src/utils/canvasEncode.js` |

`canvas.toBuffer('image/png')` — the synchronous form, used by
`scripts/image-smoke.js`, `scripts/make-og-image.js`, `scripts/make-favicon.js`
and `src/utils/eightBallImage.js` — works unchanged. The argument-less
`toBuffer()` does not exist, but nothing here calls it.

Losing the explicit `weight` on font registration sounds like a regression and
is not: `GlobalFonts` reads the weight out of the face's own metadata. Both
backends were asked to measure the same string in regular and bold DejaVu Sans
after registering the two files under one family name:

| `ctx.font` | node-canvas | @napi-rs |
|---|---:|---:|
| `28px "DejaVu Sans"` | 465.90 | 465.90 |
| `bold 28px "DejaVu Sans"` | 520.86 | 520.86 |
| `600 28px "DejaVu Sans"` | 520.86 | 520.86 |

Identical to two decimal places, bold selection included. Text will not reflow.

### Output: visually equivalent

Every `cardGenerator` surface was rendered on both backends and compared pixel
by pixel. Dimensions match exactly; the differences are anti-aliasing along text
and curve edges, which is what a different rasteriser looks like.

| Surface | Size | Mean per-channel Δ (of 255) | Pixels >8/255 apart |
|---|---|---:|---:|
| Welcome card | 800×300 | 0.16 | 0.59% |
| Rank card | 900×300 | 0.19 | 0.63% |
| War victory banner | 900×260 | 2.31 | 4.45% |
| Wealth tier banner | 900×200 | 1.11 | 3.15% |
| Achievement card | 520×110 | 3.37 | 4.85% |
| Season recap | 700×420 | 0.61 | 1.71% |

### Performance: a wash, and the encode stays off the loop

30 welcome-card-shaped renders per backend, drawing and encoding, with a 2 ms
interval sampling event-loop stall:

| Backend and encode | Per card | Worst event-loop stall |
|---|---:|---:|
| node-canvas, callback `toBuffer` (what ships) | 17.5 ms | 4.6 ms |
| node-canvas, synchronous `toBuffer` | 17.1 ms | 512.3 ms |
| @napi-rs, `encode('png')` | 16.4 ms | 7.7 ms |
| @napi-rs, synchronous `toBuffer` | 15.4 ms | 460.5 ms |

The two rows that matter are the first and third: throughput is within noise,
and `encode()` keeps the loop free exactly as the callback form does — it runs
on libuv's pool, so #592's finding survives the swap. The synchronous rows are
there to show what both backends cost if the encode is ever moved back onto the
main thread by accident.

## What is not settled

Three things could not be checked outside the container image, and each one is
a reason not to make this swap blind:

- **Colour emoji.** `src/utils/registerFonts.js` registers Noto Color Emoji
  (optionally) and the image installs `font-noto-emoji` for it. That is a
  CBDT/CBLC bitmap-colour face, and whether Skia renders it the way Cairo does
  in this image is the single largest unknown. It needs a rendered card, looked
  at, from inside the built image.
- **Remote `loadImage`.** `cardGenerator`, `/caption`, `/wanted` and `/wasted`
  hand `loadImage` a Discord CDN URL and rely on the library's own fetch, which
  is a different HTTP client on each backend. Both were seen to reject an
  unreachable URL the same way, so the failure path matches; redirect handling
  and timeout behaviour on a *successful* fetch were not observed.
  `cardGenerator` wraps the call in a 5-second deadline of its own either way.
- **Image size and build time.** The toolchain and the six runtime libraries
  come out; a statically linked Skia goes in. The `node_modules` entries alone
  measure 24 MB for `canvas` against 33 MB for `@napi-rs/canvas`, and that says
  nothing about the apk packages on either side of it — so the layer arithmetic
  needs doing on a real build rather than guessed at. Build *time* should fall
  outright, since nothing is compiled.

## The recommendation

Worth doing, not urgent, and as a change of its own.

The compatibility question — the one #933 asks to settle first — is settled:
the API gap is two call sites, the metrics are identical, the output is
equivalent and the encode stays off the event loop. What remains is verification
that can only happen in the image, so the swap should be its own pull request
whose CI runs `scripts/image-smoke.js` against a built image and whose reviewer
looks at a rendered card with an emoji in it. Bundling it with anything else
makes it un-revertable, which is the wrong property for the dependency that
draws every image the bot sends.

The change itself, when someone takes it:

1. `package.json`: `canvas` → `@napi-rs/canvas`.
2. `src/utils/registerFonts.js`: `registerFont` → `GlobalFonts.registerFromPath`.
   The `weight` field in the `FONTS` table becomes descriptive; keep it, because
   `scripts/image-smoke.js` reports on it.
3. `src/utils/canvasEncode.js`: the callback `toBuffer` → `canvas.encode('png')`.
4. The twelve remaining `require('canvas')` sites — seven under `src/`, three
   under `scripts/`, two in tests — which need nothing but the new name.
5. `Dockerfile`: delete the build stage's `apk add` entirely and drop `cairo`,
   `jpeg`, `pango`, `giflib`, `pixman` and `freetype` from the runtime stage.
   `ttf-dejavu` and `font-noto-emoji` stay — they are font files, not libraries.
6. `scripts/image-smoke.js`: its font-registration and encode checks are written
   against the two APIs that change.

Reproducing the measurements above needs `@napi-rs/canvas` installed alongside
`canvas` and a shim that maps the two changed APIs; the numbers here are from
Node 22 on glibc, so the image's own are worth re-taking.
