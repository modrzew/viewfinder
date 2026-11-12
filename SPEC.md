# Viewfinder — MVP build spec

Status: ready to build · Written: 2026-11-11 · Scope: proof of concept

## 1. What we're building

A static web app, deployed on Vercel. It renders a photorealistic 3D outdoor scene that you walk through like an FPS game, and shows it the way a specific camera and lens would capture it:
- the sensor's crop and aspect ratio,
- the lens's field of view at the chosen focal length,
- the depth of field and bokeh that come from the chosen aperture and focus distance.

The MVP has one camera body (Canon EOS 90D), two lenses (Canon EF 50mm f/1.8 STM and Canon EF-S 18-55mm f/4-5.6 IS STM) and one scene.

## 2. Decisions already made

These were agreed with the product owner. Don't reopen them during the build.

| Topic | Decision |
|---|---|
| Scene | A built 3D scene (Three.js + CC0 Poly Haven assets), not a scanned/splat capture. One scene: a garden café courtyard at golden hour with string lights. |
| Movement | FPS style: mouse look (pointer lock) + WASD walking. |
| View | One view. **Camera view** = the viewfinder (3:2 frame, lens FOV, live DoF). **Eye view** toggle = a wide human view with the current lens's frame lines drawn on top. No side-by-side. |
| Render model | Progressive. A fast approximate DoF is shown while anything changes; it refines to physically correct DoF within ~1–2 s once still. |
| Focus | Manual only, with a slider (plus keyboard). No autofocus. A centre-distance readout helps you set it. |
| Zoom | A slider for zoom lenses, hidden for primes. The mouse wheel also moves it. |
| Exposure | A toggle. **Av** (default): brightness stays constant and the readout shows the shutter speed the camera would pick. **M**: exposure is locked, so stopping down darkens the image. No motion blur, no ISO noise. |
| Lens character | In: bokeh shaped by the real blade count (round wide open, polygonal stopped down) and vignetting at wide apertures. Out: distortion, chromatic aberration, diffraction. |
| Readout | Focal length, full-frame-equivalent focal length, FOV, f-number, focus distance, DoF near/far limits. Also centre distance and shutter speed. |
| Download | 50–150 MB is fine behind a loading screen. Hard cap is 80 MB because of Vercel (§12). |
| Platform | Desktop browsers with mouse and keyboard. Mobile is out of scope. |

## 3. Scope

**In:** everything in §2, plus a loading screen, a help overlay, a debug overlay and a test scene for verifying the optics.

**Out (MVP):**
- autofocus
- mobile/touch
- other bodies and lenses (the data model is ready for them)
- distortion, chromatic aberration, diffraction, focus breathing, cat's-eye and onion-ring bokeh
- image stabilisation, motion blur, ISO noise
- saving photos
- more than one scene
- side-by-side comparison
- URL or saved state

## 4. Target hardware and browsers

- Reference machine: an Apple M1-class laptop (integrated GPU). Anything with a discrete GPU should be fine if this runs well.
- Latest desktop Chrome, Safari and Firefox. Requires WebGL2 with `EXT_color_buffer_float`; otherwise show a plain error screen.
- Targets on the reference machine:
  - interactive mode at ≥ 50 fps at the default window size
  - the refined image (256 samples) in ≤ 2 s in the test scene and ≤ 3 s in the courtyard

## 5. Stack and repo

The repo is a Vite 8 + React 19 + TypeScript 7 template with bun, oxlint and the React Compiler. Keep that setup. Remove the template's demo content: `src/App.css`, `src/assets/*`, the demo markup in `App.tsx`, and `public/icons.svg`.

Add:

| Package | Why |
|---|---|
| `three` (0.187.x) + `@types/three` | rendering |
| `three-mesh-bvh` | fast raycasts for the centre-distance readout |
| `zustand` | settings store shared by the React UI and the render loop |
| `@gltf-transform/cli` (dev) | asset optimisation script |

Rules:
- A `Viewer` class drives Three.js imperatively. React only renders the UI and holds no per-frame state. Don't use react-three-fiber: the custom multi-pass and accumulation loop is easier without it.
- All optics maths lives in pure TS functions with no Three imports, unit-tested with `bun test`.
- Scene units are metres. Optics maths uses millimetres internally; convert at the boundary.
- Add the scripts `"test": "bun test"` and `"assets": "bun scripts/fetch-assets.ts"`. Extend `build` to run the asset budget check (§12).

## 6. Architecture

```
          ┌──────────────── React UI ────────────────┐
          │ Hud   HelpOverlay   FrameLines   ...     │
          └───────┬──────────────────────▲───────────┘
          setters │                      │ subscribe
                  ▼                      │
            store (zustand): settings + runtime info
                  │ getState() every frame
                  ▼
   optics/deriveOptics(body, lens, settings) → DerivedOptics   (pure, shared by UI + renderer)
                  │
                  ▼
   Viewer (render loop) ── FpsController (input, collisions)
     ├─ scene: courtyard | test
     ├─ GatherDofPass  (interactive preview)
     ├─ Accumulator    (refined: jittered thin-lens renders)
     ├─ LensPass       (exposure, vignetting) → OutputPass (AgX tone map, sRGB)
     └─ Rangefinder    (centre distance → store.runtime)
```

File layout:

```
SPEC.md
vercel.json
scripts/
  assets.manifest.ts        # which Poly Haven assets, at what resolution
  fetch-assets.ts           # download + optimise into public/scene/
  check-asset-budget.ts     # fails the build if public/scene > 80 MB
public/scene/               # generated by `bun run assets`, committed
  hdri/  models/  textures/
src/
  main.tsx  App.tsx  config.ts          # config.ts = quality/perf constants
  optics/
    types.ts  bodies.ts  lenses.ts
    stops.ts                            # aperture + shutter third-stop series
    optics.ts                           # deriveOptics + formulas (§8)
    aperture.ts                         # shape + sample generation (§10.5)
    focusScale.ts                       # slider ↔ distance (§8.6)
    *.test.ts
  state/store.ts
  render/
    Viewer.ts  FpsController.ts  Rangefinder.ts  jitteredProjection.ts
    passes/GatherDofPass.ts  passes/Accumulator.ts  passes/LensPass.ts
    shaders/                            # GLSL; blur formula mirrors optics.ts
  scene/
    courtyard.ts  layout.ts  stringLights.ts  testScene.ts  loadAssets.ts
  ui/
    Viewport.tsx  Hud.tsx  FrameLines.tsx
    LoadingScreen.tsx  HelpOverlay.tsx  DebugOverlay.tsx  styles.css
```

## 7. Camera and lens data

### 7.1 Types

```ts
export type Mount = 'EF' | 'EF-S';

export interface CameraBody {
  id: string;
  name: string;
  acceptsMounts: Mount[];            // lens mounts that physically fit
  sensorWidthMm: number;             // active image width
  imageAspect: number;               // width / height of the recorded image
  imagePx: { width: number; height: number };
  cocMm: number;                     // circle of confusion for DoF readouts
  cropFactorNominal: number;         // for "equivalent focal length" display
  shutterRangeS: { fastest: number; slowest: number };  // nominal powers of two behind the labels (§8.5)
}

export interface FocalStep { fromFocalMm: number; fNumber: number }

export interface Lens {
  id: string;
  name: string;
  mount: Mount;
  focalMm: { min: number; max: number };          // min === max for primes
  maxAperture: FocalStep[];                       // widest f-number by focal length
  minAperture: FocalStep[];                       // smallest f-number by focal length
  closestFocusM: number;
  blades: number;
  roundness: { wideOpen: number; stoppedDown: number; stopsToStoppedDown: number };
  vignetteCornerEv: { focalMm: number; ev: number }[];  // at widest aperture; interpolate linearly
  info: { maxMagnification: string; construction: string; filterMm: number; weightG: number };
  estimated: string[];                            // fields that are estimates, not published specs
}
```

`canMount(body, lens) = body.acceptsMounts.includes(lens.mount)`. The lens dropdown lists only lenses that mount.

### 7.2 Canon EOS 90D

| Field | Value | Note |
|---|---|---|
| acceptsMounts | EF, EF-S | APS-C body |
| Sensor | 22.3 × 14.8 mm (Canon) | Use the width 22.3; derive height from 3:2 → 14.87 mm |
| imagePx | 6960 × 4640 | 3:2; 32.5 MP effective |
| cocMm | 0.019 | Common DoF-calculator value for Canon APS-C (e.g. DOFMaster); not a Canon spec |
| cropFactorNominal | 1.6 | The computed value is 1.614; Canon quotes the 18-55 as 29–88 mm equivalent, i.e. ×1.6 |

### 7.3 Lenses

| | EF 50mm f/1.8 STM | EF-S 18-55mm f/4-5.6 IS STM |
|---|---|---|
| Mount | EF | EF-S |
| Focal length | 50 mm | 18–55 mm |
| Widest aperture | f/1.8 | f/4 (18 mm) – f/5.6 (55 mm) |
| Smallest aperture | f/22 | f/22 (18 mm) – f/32 (55 mm) |
| Closest focus | 0.35 m | 0.25 m |
| Max magnification | 0.21× | 0.25× (at 55 mm) |
| Blades | 7, circular | 7, circular |
| Construction | 6 elements / 5 groups | 12 elements / 10 groups |
| Filter / weight | 49 mm / 160 g | 58 mm / 215 g |
| Published angle of view (H / V / D) | — | 64°30′ / 45°30′ / 74°20′ at 18 mm; 23°20′ / 15°40′ / 27°50′ at 55 mm |

**Aperture by focal length for the 18-55 (estimated).** Canon publishes only the endpoints. The breakpoints below are where a power law N ∝ f^0.311 between the published endpoints crosses each third-stop midpoint. If someone has the lens, replace them with measured values: set Av mode at the widest aperture, zoom slowly, and note where the f-number changes.

| Focal length | Widest | Smallest |
|---|---|---|
| 18–21 mm | f/4 | f/22 |
| 22–31 mm | f/4.5 | f/25 |
| 32–45 mm | f/5 | f/29 |
| 46–55 mm | f/5.6 | f/32 |

**Bokeh and vignetting constants (estimated, tune by eye):**
- Roundness: `wideOpen 1.0`, `stoppedDown 0.35`, `stopsToStoppedDown 2` for both lenses.
- `vignetteCornerEv`:
  - 50mm: 0.8 EV.
  - 18-55: 1.0 EV at 18 mm, falling to 0.6 EV at 55 mm.

## 8. Optics model

Notation:
- Lengths are in mm unless noted.
- Distances are measured from the camera position, which is treated as the lens. Canon measures closest focus from the sensor plane; ignore that difference.
- `f` = focal length, `N` = f-number, `s` = focus distance, `d` = subject distance (planar depth along the view axis), `c` = CoC, `W` = sensor width, `Hs = W / imageAspect`.

### 8.1 Field of view

```
hfov = 2·atan(W / 2f)     vfov = 2·atan(Hs / 2f)     dfov = 2·atan(√(W² + Hs²) / 2f)
equivalentFocal = f · cropFactorNominal
```

Focus breathing is ignored: FOV is always the infinity-focus value. Three's `PerspectiveCamera.fov` is `vfov` in degrees, and `aspect = imageAspect`.

### 8.2 Aperture

- **Third-stop series** (nominal values, used both for display and in the maths): `1.8 2 2.2 2.5 2.8 3.2 3.5 4 4.5 5 5.6 6.3 7.1 8 9 10 11 13 14 16 18 20 22 25 29 32`.
- **Requested vs effective.** Store the user's *requested* f-number. The effective `N = clamp(requested, maxAperture(f), minAperture(f))`. So zooming from 18 to 55 mm at f/4 shows f/5.6, and zooming back returns to f/4, like a Canon body.
- **Stops down from wide open:** `Δ = 2·log2(N / maxAperture(f))`.
- **Aperture diameter:** `A = f / N`.

### 8.3 Depth of field (readout)

```
H    = f² / (N·c) + f
near = s·(H − f) / (H + s − 2f)          s = ∞  →  near = H − f
far  = s·(H − f) / (H − s)   if s < H, otherwise ∞
```

### 8.4 Blur disc (render)

```
b(d)  = A · f / (s − f) · |d − s| / d    s = ∞  →  b = A·f / d
b_px  = b / W · renderWidthPx
sign: negative for d < s (near field), positive for d > s (far field)
```

Both DoF renderers must use this function. The GLSL mirrors `optics.ts`, and the debug overlay (§10.8) compares the two.

### 8.5 Exposure

```
correct time  t_c = N² / 2^EV100       ISO 100; EV100 is a scene constant, per time of day (§11.8)
Av:  t = clamp(t_c, fastest, slowest)  the 90D's range is 1/8000 (2^−13 s) to 30″ (2^5 s)
M:   on entering M, lock N_lock = N and t_lock = t; then t = t_lock
both: brightness factor = t / t_c       EV offset = log2(t / t_c)
```

So Av brightness is constant until the shutter hits a limit (f/1.8 at noon wants 1/10000 and comes out ⅓ EV over). In M at the lock's EV100 the factor is `(N_lock / N)²`; changing the time of day in M changes EV100 and so the exposure, as it would on a camera.

Shutter label: `k = round(3·log2(1/t))`, then look up the Canon nominal label for k:

| k | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| label | 1″ | 0″8 | 0″6 | 0″5 | 0″4 | 0″3 | 1/4 | 1/5 | 1/6 | 1/8 | 1/10 | 1/13 | 1/15 | 1/20 | 1/25 | 1/30 | 1/40 | 1/50 | 1/60 | 1/80 |

| k | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30 | 31 | 32 | 33 | 34 | 35 | 36 | 37 | 38 | 39 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| label | 1/100 | 1/125 | 1/160 | 1/200 | 1/250 | 1/320 | 1/400 | 1/500 | 1/640 | 1/800 | 1/1000 | 1/1250 | 1/1600 | 1/2000 | 1/2500 | 1/3200 | 1/4000 | 1/5000 | 1/6400 | 1/8000 |

Long exposures (k < 0): `1″3 1″6 2″ 2″5 3″2 4″ 5″ 6″ 8″ 10″ 13″ 15″ 20″ 25″ 30″` for k = −1 … −15.

Show the EV offset in thirds, e.g. `−1⅓ EV`: always in M, and in Av when the shutter is at a limit (the info bar then blinks the shutter speed, like the camera).

### 8.6 Focus slider mapping

- The slider takes integer positions `p` from 0 to 1000.
- For `p < 1000`: `s = s_min · (1000 m / s_min)^(p / 999)`. Position 1000 is ∞.
- Implement the inverse too, for setting the slider from a distance.
- Keys `−` / `=` move ±1 position (Shift: ±10).
- Display: two decimals below 10 m, one decimal below 100 m, integers above that, and `∞`.
- When switching lens, keep focus in metres, clamp it to the new lens's closest focus, and recompute the slider position.

### 8.7 Test vectors (`optics.test.ts`; c = 0.019, W = 22.3, 3:2)

| Case | Expected |
|---|---|
| FOV 18 mm (H/V/D) | 63.55° / 44.88° / 73.33° (Canon: 64°30′/45°30′/74°20′; within 1.5° is expected) |
| FOV 50 mm | 25.14° / 16.91° / 30.01° |
| FOV 55 mm | 22.92° / 15.39° / 27.39° (Canon: 23°20′/15°40′/27°50′) |
| DoF 50 mm f/1.8, s = 2 m | H 73.15 m, near 1.948 m, far 2.055 m |
| DoF 18 mm f/8, s = ∞ | H 2.150 m, near 2.132 m, far ∞ |
| DoF 55 mm f/5.6, s = 3 m | near 2.718 m, far 3.347 m |
| Blur 50 mm f/1.8, s = 1 m, d = ∞ | 1.462 mm = 125.9 px at 1920 px width |
| Blur 55 mm f/5.6, s = 1.5 m, d = 20 m | 0.346 mm = 29.8 px at 1920 px |
| Av shutter, EV100 = 12 | f/1.8 → 1/1250, f/8 → 1/60, f/22 → 1/8 |
| 18-55 widest aperture | 18 → 4, 21 → 4, 22 → 4.5, 31 → 4.5, 32 → 5, 45 → 5, 46 → 5.6, 55 → 5.6 |
| Requested f/4, zoom to 55 then back to 18 | effective 5.6, then 4 |
| Focus slider | p = 0 → s_min; p = 1000 → ∞; inverse(forward(p)) = p |

## 9. Controls and UI

### 9.1 Layout

- **Viewport and HUD.** The viewport fills the window. All UI is a game-style HUD drawn over it (§9.2). Every setting is shown next to the key that changes it, so nothing needs the mouse. The HUD ignores the mouse: clicking anywhere captures it. U hides the HUD.
- **Camera view:**
  - The frame is the largest 3:2 rectangle that fits the viewport, centred, with black around it.
  - A small centre AF-point square marks what the centre-distance readout measures; the distance is shown under it.
  - A refine indicator at the top centre shows progress (`Refining 96/256` with a bar, then nothing once done).
- **Eye view:**
  - Covers the full viewport, horizontal FOV 90°, aspect taken from the window.
  - Draws a frame-lines rectangle for the current lens, labelled (e.g. `50 mm`). Its half-width fraction is `tan(hfov_lens/2) / tan(hfov_eye/2)`; the half-height fraction is the same with vfov.
  - No DoF and no vignette; same exposure and tone mapping as the camera view.
- **Overlays:**
  - Loading screen showing MB loaded / total.
  - Help overlay (H) listing the controls, shown automatically on first load.

### 9.2 HUD

Small clusters in the corners, styled after shooter HUDs: no panels behind them, icons rather than labels, white condensed type (Barlow Condensed) with a dark halo, and segmented bars standing in for sliders. The side clusters tilt slightly toward the centre. Key prompts are outlined letters. Everything scales with the window height (1× at 900 px, clamped to 0.8–1.4×).

**Bottom left: the body and its settings.** A heading with the body name, then one row per setting: an icon, its keys, the value, a note, and a bar.

| Row | Keys | Value and note | Bar |
|---|---|---|---|
| Aperture | `[` `]` | `f/5.6`. When clamped, a red tag such as `widest at 55 mm`. | One segment per third-stop within the current limits, lit up to the current one. |
| Focus | `−` `=` | The distance; the depth of field (`1.95 – 2.05 m`). | The focus scale (§8.6): the depth of field lit, the focus distance marked, and a tick under what's at the AF point. |
| Exposure | X | `Av` or `M`, the shutter speed, and `ISO 100`. In M, or in Av at a shutter limit, the EV offset too (`ISO 100 · −1⅓ EV`). In Av at a limit the shutter speed blinks and the note turns into a red tag. | Exposure level, ±3 EV in thirds, lit from the middle out to the offset. |

**Bottom right: the lens, like a weapon loadout.** The lens name, the focal length in large type with `56 mm equiv. · 35.3° × 24.0°` under it, a zoom bar and the wheel prompt (zoom lenses only), and a slot per lens that mounts, the current one filled, after the L prompt.

**Top left:** chips for View (V: camera or eye) and Time of day (T, courtyard only, with sky download progress), each a key, an icon badge and the current value.

**Top right:** prompts for Tab (details), U (hide HUD) and H (help), with the fps counter, or the debug overlay with `?debug=1` (§10.8), under them.

**Hold Tab** for the full readout in a card:
- Focal length with equivalent: `35 mm (56 mm equiv.)`.
- FOV: `H 35.3° · V 24.0° · D 41.9°`.
- f-number, with the clamp hint.
- Shutter with ISO and EV offset.
- Focus distance.
- DoF: `1.95 – 2.05 m (11 cm deep)` or `2.13 m – ∞ (to infinity)`.
- Hyperfocal distance.
- Distance at the AF point.

A changed setting briefly turns amber, so a key press shows what it did.

### 9.3 Input

| Input | Action |
|---|---|
| Click viewport | Capture the mouse (pointer lock). Esc releases it. |
| Mouse | Look. Sensitivity scales with `tan(vfov/2)` so aiming at 55 mm is as controllable as at 18 mm. Pitch is clamped to ±85°. |
| W A S D | Walk at 1.4 m/s (Shift ×2.5), with ~0.1 s smoothing. |
| Q / E | Lower / raise eye height (0.3–1.9 m, default 1.2). |
| Wheel | Zoom ±1 mm per notch (Shift ±5). Zoom lenses only. |
| `[` / `]` | Aperture wider / narrower by ⅓ stop. |
| `−` / `=` | Focus nearer / farther (Shift ×10). |
| V | Camera / Eye view. |
| X | Av / M. |
| L | Next lens. |
| T | Next time of day (courtyard only). |
| R | Back to spawn. |
| Tab (hold) | Details: the full readout. |
| U | Hide / show the HUD. |
| H | Help overlay. |

Shortcuts work with or without pointer lock. Ignore them while a form control has focus.

### 9.4 State

```ts
interface Settings {
  bodyId: string;
  lensId: string;
  focalMm: number;
  requestedFNumber: number;
  focusM: number;                                   // Infinity allowed
  exposureMode: 'Av' | 'M';
  manualLock: { fNumber: number; shutterS: number } | null;
  view: 'camera' | 'eye';
  timeOfDay: 'noon' | 'golden' | 'evening' | 'night';
}
interface Runtime {
  centreDistanceM: number | null;                   // null = sky
  refine: { samples: number; target: number };
  loading: { loadedBytes: number; totalBytes: number } | null;
  ev100: number;                                    // of the lighting on screen
  timeOfDayLoading: { timeOfDay; loadedBytes; totalBytes } | null;
}
```

- **Defaults:** EOS 90D, 50mm, f/1.8, focus 1.0 m, Av, camera view, golden hour.
- **Lens switch:**
  - Clamp the focal length to the new range.
  - Keep focus, clamped to the new lens's closest focus.
  - Keep the requested f-number; the effective value clamps.
  - Keep `manualLock`.

## 10. Rendering

### 10.1 Frame loop and modes

There are three modes: `INTERACTIVE → REFINING → DONE`.

- **Changes that reset:**
  - An *optical* change (pose, lens, focal length, aperture, focus, window size, view) switches to `INTERACTIVE` and resets the accumulation.
  - An *exposure-only* change (Av/M) re-runs `LensPass` on the current buffer and keeps the accumulation.
- **INTERACTIVE:** render the centred camera → `GatherDofPass` → `LensPass` → screen. If nothing optical changed during the frame, keep the result as the *preview* and switch to `REFINING`.
- **REFINING:**
  - Render jittered samples into `Accumulator` in batches of k, each ending in a fence. Two batches stay queued, so the GPU goes straight from one to the next; k adapts between 1 and 16 so a batch is done within ~33 ms of being issued, queue wait included, which bounds how long a change waits behind refinement. When one sample alone is too slow for that, a single batch of one is queued.
  - Show the preview until n ≥ 32, then crossfade to the accumulation over ~150 ms.
  - At n = target (default 256), switch to `DONE`.
- **DONE:** no GPU work until something changes. The UI stays live.
- **Eye view:** one plain render per frame, no DoF, no refinement.

### 10.2 Targets and colour

- **Scene target:** RGBA16F with a `DepthTexture`. Linear, no tone mapping.
- **Accumulation:** two RGBA32F targets, ping-ponged, holding a running mean `acc_n = acc_(n−1) + (x − acc_(n−1)) / n`. Fall back to RGBA16F if 32F isn't renderable.
- **`LensPass`:** works in linear: applies exposure × vignette. Then three's `OutputPass` applies `AgXToneMapping` and sRGB output.
- **Internal resolution:** viewfinder CSS px × min(devicePixelRatio, 1.5), capped at 2560 px wide (`config.ts`). Interactive mode and the eye view step down to 0.85×, 0.7×, 0.6× and 0.5× while fps < 45, and back up once frames are fast again (`DynamicResolution.ts`). Refinement always renders at full resolution.
- **Camera clip planes:** near 0.03 m, far 2000 m.
- **Shadows:** the shadow map is rendered once after load (`renderer.shadowMap.autoUpdate = false`), since the scene is static.
- **No SSAO or SSR.** Both fight the accumulation and cost per sample. Ambient occlusion comes from the glTF AO maps.

### 10.3 Refined DoF: jittered thin-lens accumulation (ground truth)

This is accumulation-buffer DoF (Haeberli & Akeley, 1990). Each sample renders the full scene from a point on the aperture, with a sheared frustum so that the plane at distance `s` stays fixed. This gives:
- physically correct blur
- partial occlusion at foreground edges
- bokeh in exactly the aperture's shape
- free anti-aliasing (from the sub-pixel jitter)

For sample i, with aperture point `(ax, ay)` in the unit aperture shape (§10.5) and pixel jitter `(jx, jy) ∈ [−½, ½]`. All lengths are in metres here:

```
R       = (A/2) · s/(s − f)     // effective aperture radius; s/(s−f) makes the blur equal b(d) exactly (→ A/2 at s = ∞)
u, v    = R·ax, R·ay            // camera offset along its right / up axes
invS    = s === ∞ ? 0 : 1/s
tx, ty  = tan(hfov/2), tan(vfov/2)
left    = n·(−tx − u·invS) + jx·(2n·tx / Wpx)
right   = n·( tx − u·invS) + jx·(2n·tx / Wpx)
bottom  = n·(−ty − v·invS) + jy·(2n·ty / Hpx)
top     = n·( ty − v·invS) + jy·(2n·ty / Hpx)

camera.position = base + rightAxis·u + upAxis·v     // orientation unchanged
camera.projectionMatrix.makePerspective(left, right, top, bottom, n, far)
camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
```

Gotchas:
- Never call `camera.updateProjectionMatrix()` while refining. It overwrites the sheared matrix.
- Restore the base camera after each sample loop.
- The HDRI background is drawn with the camera's projection matrix, so it gets sheared correctly and blurs correctly when `s < ∞`.

**Sample count.** The target is 256 (configurable from 64 to 1024). The case to watch: at 50 mm f/1.8 focused at 1 m, the background blur is ~126 px, so 256 samples sit ~7 px apart. Point lights can then show *dotted* bokeh. If that's visible, add the mitigation:
- Per-sample residual blur: after rendering each sample, run a small gather blur before accumulating it.
- Radius `0.45·|b_px(depth)| / √target`, clamped to ≤ 8 px, using that sample's own depth.

### 10.4 Interactive DoF: single-pass gather

This is a responsive preview; artefacts at depth edges are acceptable. It's based on "Bokeh depth of field in a single pass" (Dennis Gustafsson, 2018).

1. **CoC pass (half resolution):** compute the signed `b_px / 2` from linearised depth (§8.4). Store it with the colour in RGBA16F.
2. **Gather (half resolution):**
   - Iterate over an aperture-shaped kernel around each pixel: 64 offsets from §10.5, sorted by radius and scaled to the max radius.
   - A sample contributes if its own CoC radius is ≥ its offset distance (smoothstep over 1 px).
   - Clamp the CoC of samples farther than the centre pixel to 2× the centre pixel's CoC. This stops the background bleeding over in-focus foreground.
3. **Composite (full resolution):** mix the sharp full-res colour with the blurred half-res colour by `smoothstep(0.5, 1.5, |CoC_px|)`.

Clamp the blur radius to 48 px at full resolution (`config.ts`). Larger blur is clipped in the preview only.

### 10.5 Aperture shape

A unit shape with `n = blades`, rounded by `r ∈ [0, 1]`:

```
polygon(θ) = cos(π/n) / cos(((θ − θ0) mod (2π/n)) − π/n)       // circumradius 1
radius(θ)  = mix(polygon(θ), 1, r)
r          = mix(roundness.wideOpen, roundness.stoppedDown, clamp(Δ / roundness.stopsToStoppedDown, 0, 1))
```

- Scale the shape so its area equals the unit circle's, since the f-number defines the area.
- `θ0` is a fixed blade orientation (e.g. 90°).
- **Samples:** take an R2 low-discrepancy sequence (Roberts) in [−1, 1]² and reject points outside `radius(θ)`. Every prefix of the list is then evenly spread, which progressive refinement needs.
- Generate on the CPU whenever the lens or aperture changes: 1024 accumulation points plus 64 gather-kernel offsets.
- Pixel jitter uses a separate R2 sequence.

### 10.6 LensPass

- **Exposure:** `baseExposure` (a scene constant) × (`M` ? `(N_lock/N)²` : 1).
- **Vignetting:**
  - `ρ` = distance from the frame centre, normalised so the corner is 1.
  - Factor = `2^(−v·ρ²)`.
  - `v = vignetteCornerEv(f) · clamp(1 − Δ/2, 0, 1) + 0.15`.
- Then `OutputPass`.
- Eye view applies exposure only, without vignetting.

### 10.7 Rangefinder

- After load, call `three-mesh-bvh`'s `computeBoundsTree` on all scene meshes and enable accelerated raycasting.
- Cast a ray from the camera centre along the view direction, at most 10 Hz and only when the pose changes.
- Write the planar depth of the hit to `store.runtime.centreDistanceM`, or `null` for sky.

### 10.8 Debug overlay (`?debug=1`)

- Shows fps, mode, sample count and samples per frame.
- Draws the predicted bokeh circle `b_px(centre distance)` around the reticle, so the render can be compared with the maths by eye.
- Has keys to toggle individual passes.

## 11. Scene: café courtyard

### 11.1 Intent

- **Something at every distance band**, so every focus setting has something sharp and something blurred:
  - tabletop props at 0.3–1 m
  - café furniture at 2–8 m
  - string-light bulbs at 2–20 m
  - facades at 25+ m
  - sky at ∞
- **A long axis (~30 m)**, so you can frame the same table with 18 mm up close and with 55 mm from far away. That shows perspective compression.
- **Small bright sources** (string-light bulbs, a lantern, specular glints on glass and brass) to show bokeh shape and aperture changes.

### 11.2 Layout

Coordinates are in metres: +x right, −z forward from spawn, y up. Tune by eye.

| Element | Placement |
|---|---|
| Ground | Cobblestone, x −9…9, z +4…−26 |
| South wall (behind spawn) | Plaster, 3.5 m high, at z = +4 |
| North | Apartment facade at z ≈ −26 |
| East | Apartment facade (rotated) at x ≈ +9 |
| West | Open side: planter boxes with shrubs and flowers, plus the iron gate. The low sun shines in from here, over the HDRI horizon. |
| Spawn | (0, 1.2, 0), facing −z, pitch −15° |
| Hero table | Outdoor table set centred at (0, 0, −0.7). Props on it: tea set, croissant, small potted plant, vase, lantern, all 0.5–1.0 m from the spawn eye. |
| Other tables | Three more table sets at about (−3, −4), (3.5, −6), (−2, −11); a gallinera table and chairs at (4, −12) |
| Props | Coffee cart at (6, −3); wine barrel with bottles at (−5, −7); bench along the east side; potted plants near the tables |
| Post lamps | At (5, −16) and by the gate at (−8.15, −16.15), with emissive heads |
| Wall lanterns | Eight `street_lamp_02` brackets at 2.3 m on facade bay joints: north at x = −6, 0, 6; east at z = −20, −11, −2; south wall at x = ±4.5 |
| Table lanterns | `Lantern_01` with a candle on every table |
| String lights | Four strands across x −8…8 at z = −3, −8, −13, −18. 3.6 m high at the ends, 0.5 m catenary sag, a bulb every 0.5 m (~130 bulbs). |

### 11.3 Assets (Poly Haven, all CC0)

| Role | Poly Haven id | Res | Raw size |
|---|---|---|---|
| Hero table + chairs (reused for the other tables) | `outdoor_table_chair_set_01` | 2k | 3.2 MB |
| Tea set | `tea_set_01` | 2k | 5.2 MB |
| Croissant | `croissant` | 2k | 6.9 MB |
| Small potted plant | `potted_plant_04` | 2k | 6.3 MB |
| Lantern | `Lantern_01` | 2k | 3.0 MB |
| Vase | `ceramic_vase_01` | 2k | 0.7 MB |
| Wine bottles | `wine_bottles_01` | 1k | 3.9 MB |
| Bistro table + chair | `gallinera_table`, `gallinera_chair` | 1k | 4.2 MB |
| Potted plants | `potted_plant_01`, `potted_plant_02` | 1k | 8.9 MB |
| Planter + plants | `planter_box_01`, `shrub_03`, `flower_gazania` | 1k | 6.7 MB |
| Coffee cart | `CoffeeCart_01` | 1k | 1.8 MB |
| Post lamps | `street_lamp_01` | 1k | 2.2 MB |
| Wall lanterns | `street_lamp_02` | 1k | 2.2 MB |
| Bench | `painted_wooden_bench` | 1k | 2.0 MB |
| Wine barrel | `wine_barrel_01` | 1k | 0.9 MB |
| Gate | `large_iron_gate` | 1k | 3.1 MB |
| Facades | `modular_urban_apartments_facade` | 1k | 16.5 MB |
| Ground texture | `cobblestone_floor_06` (diff, nor_gl, arm) | 2k | ≤ 12 MB |
| Wall texture | `clay_plaster` (diff, nor_gl, arm) | 1k | ≤ 4 MB |
| Sky + lighting, golden hour | `venice_sunset` HDRI | 4k `.hdr` | 22.8 MB |
| Noon sky | `kloofendal_48d_partly_cloudy_puresky` | 2k `.hdr` | 5.5 MB |
| Evening sky | `qwantani_dusk_2_puresky` | 2k `.hdr` | 4.6 MB |
| Night sky | `qwantani_night_puresky` | 2k `.hdr` | 5.5 MB |

- The raw total is about 130 MB. After meshopt + WebP it's about 64 MB; the budget check (§12) verifies this. The extra skies are 2k because three more 4k ones would break the budget; pure skies are smooth enough for it.
- Poly Haven's trees are too heavy for this budget (`jacaranda_tree` is 215 MB at 1k), so the MVP has no trees. Greenery comes from planters, shrubs and potted plants.

### 11.4 Lighting

This is golden hour; §11.8 covers the other times of day.

- **HDRI:** `venice_sunset` serves as `scene.environment` (via PMREM) and as `scene.background`.
  - Rotate both (`backgroundRotation` / `environmentRotation`) so the sun sits over the open west side, ~70° left of the spawn view. That side-lights the spawn view.
  - Alternatives if it doesn't look right: `kiara_1_dawn`, `spruit_sunrise`.
- **Sun:** a `DirectionalLight` aligned with the HDRI's sun.
  - Store the azimuth and elevation in the scene config. A dev helper logs the direction of the brightest HDRI texel.
  - Warm colour, a 4096² PCF soft shadow map covering the courtyard, rendered once.
- **Bulbs:** emissive only, no light per bulb. Warm (~2700 K) colour. In linear terms, make them ~20–50× scene mid-grey so they read as bright bokeh balls.
- **Lantern:** one small warm `PointLight` on the hero table, no shadows. The other lanterns' flames glow but cast no light.
- **Scene constants:** `baseExposure = 1.3`, `EV100 = 12`.

### 11.5 String lights

- Procedural, built in `stringLights.ts`.
- Wire: a `TubeGeometry` along a catenary, dark, 4 mm thick.
- Bulbs: an `InstancedMesh` of a low-poly ~4 cm bulb with an emissive material, plus a socket. One draw call per material.

### 11.6 Movement and collisions

- The player is a circle with radius 0.15 m on the ground plane. Eye height comes from Q/E.
- Colliders are circles and boxes in `layout.ts` (table sets, cart, barrel, planters, lamp), plus the courtyard bounds.
- Resolve collisions by pushing the circle out. No physics engine.

### 11.7 Test scene (`?scene=test`)

Used to verify the optics. Built in code, with no downloads:
- a grey checkerboard ground with 1 m lines
- targets at 0.5, 1, 2, 4, 8, 16 and 32 m along −z, each a card with its distance printed on it and a tiny bright emissive sphere (point source) on top
- a gradient sky

### 11.8 Times of day

`scene/courtyardLighting.ts` holds a preset per time of day; `scene/timeOfDay.ts` is the plain list shared with the UI.

| | Noon | Golden hour | Evening | Night |
|---|---|---|---|---|
| EV100 | 15 | 12 | 9 | 7.5 |
| Sky | `kloofendal_48d…` | `venice_sunset` | `qwantani_dusk_2…` | `qwantani_night…` |
| Sun | From the sky, 48° up, 125° left of the spawn view | As §11.4 | Set; the afterglow sits in the west | None |
| Lamps | Off: plain glass bulbs, no flames | Glow, as §11.4 | On | On |
| Lit windows | — | — | 35% | 55% |

- **Exposure follows EV100:** `baseExposure = 1.3 · 2^(12 − EV100)`. All lights share one set of units, so lamps keep the same emissive and intensity at every time of day; they only look brighter at night because the exposure is longer. Tune sky, sun and environment intensities per preset, not the exposure.
- **Environment below background:** the walls hide much of the sky, which image-based light ignores, so `environmentIntensity` is about half of `backgroundIntensity` (as at golden hour).
- **Noon sun:** texels above a clamp are taken out of the HDRI before PMREM, and the irradiance removed becomes the `DirectionalLight` (colour and intensity). The sun then lights the scene once, with shadows. Its shadow camera is fitted to the courtyard.
- **Lamps on:** festoons get 4 stand-in `PointLight`s per strand carrying the bulbs' luminous intensity (emissive × projected area); post lamps are `SpotLight`s with 1024² shadows; wall lanterns and candles are `PointLight`s without shadows. The dark interior behind the windows goes black, since point lights shine through walls.
- **Lit windows:** a glow plane (curtain texture, per-window warm tint and dimming) behind each opening, picked by a fixed hash. The facade glass is opaque, so it turns 20% opaque while windows are lit.
- **Switching:** only the initial sky loads with the scene; others download on first use, with progress on the HUD. The Viewer relights the scene, compiles the new shaders with `compileAsync` while the old image stays up, re-renders the shadow maps and resets refinement. A newer choice supersedes one still loading.
- **Overflow guard:** the noon sun's glints can overflow the half-float scene target. The passes read scene colour through `sceneColor()`, which clamps to the largest finite half and drops NaN.

## 12. Asset pipeline and budget

- **`scripts/assets.manifest.ts`:** lists entries of the form `{ id, kind: 'model' | 'texture' | 'hdri', res }`, matching §11.3.
- **`scripts/fetch-assets.ts` (bun):** for each entry, `GET https://api.polyhaven.com/files/{id}` (send a `User-Agent` naming the app) and download the listed files into `.assets-cache/` (gitignored). Then:
  - models: `gltf-transform optimize <in>.gltf public/scene/models/<id>.glb --compress meshopt --texture-compress webp --texture-size <1024|2048>`
  - textures: copy the `diff`, `nor_gl` and `arm` JPGs to `public/scene/textures/<id>/`
  - HDRI: copy the `.hdr` to `public/scene/hdri/`
- **Commit `public/scene/`**, so deploys don't depend on Poly Haven.
- **Runtime loading:** `GLTFLoader` + `MeshoptDecoder`, `HDRLoader`, `TextureLoader`. A `LoadingManager` drives the loading screen.
- **Budget:** `public/scene/` ≤ 80 MB, enforced by `scripts/check-asset-budget.ts` as part of `build`. The reason: Vercel Hobby caps the source upload of a CLI deployment at 100 MB. If the budget is exceeded:
  1. drop hero props to 1k
  2. as a last resort, move assets to Vercel Blob
- **Credits:** list the assets in the README. CC0 doesn't require credit, but it's polite.

## 13. Deploy (Vercel)

`vercel.json`:

```json
{
  "framework": "vite",
  "installCommand": "bun install",
  "buildCommand": "bun run build",
  "outputDirectory": "dist",
  "headers": [
    { "source": "/scene/(.*)", "headers": [{ "key": "Cache-Control", "value": "public, max-age=604800" }] }
  ]
}
```

- Static only: no functions, no environment variables.
- Scene assets live under `/scene/` because Vite's hashed build output already uses `/assets/`.

## 14. Milestones

Each milestone ends in something you can run and check.

| # | Milestone | Done when |
|---|---|---|
| M1 | **Optics core**: `optics/*`, data, tests | `bun test` passes every vector in §8.7. No Three imports in `optics/`. |
| M2 | **Viewer shell**: renderer, FpsController, test scene, store, panel, readout, camera and eye views, frame lines, rangefinder, shortcuts. No DoF yet (pinhole render). | In the test scene, a 1 m-wide card at 2.24 m exactly fills the frame width at 50 mm. Rangefinder readings are within 1% of the card distances. Eye-view frame lines match the camera-view framing. All controls and shortcuts work. Clamping follows §8.2. |
| M3 | **Refined DoF**: Accumulator, jittered projection, aperture sampling | In the test scene, point-source bokeh diameters match the debug circle within 10% for 50 mm f/1.8 at s = 1 m, 55 mm f/5.6 at s = 1.5 m, and 18 mm f/4 at s = 0.5 m. Bokeh is round at the widest aperture and visibly heptagonal at f/8+. A blurred near card shows the background through its edges. 256 samples finish in ≤ 2 s on the reference machine. |
| M4 | **Interactive DoF and mode switching** | Moving and dragging sliders shows the gather preview at ≥ 50 fps. Stopping crossfades to the refined image within ~2 s, with no jump in blur size (preview and refined radii agree within ~15% where not clamped). `DONE` does no GPU work. |
| M5 | **LensPass and exposure** | Av: mean linear luminance is constant from f/1.8 to f/22 (±5%). M: it halves per stop (±10%). Shutter readouts match §8.7. Vignetting is visible in the corners at f/1.8 and gone by f/4. |
| M6 | **Courtyard scene**: asset script, budget check, layout, lighting, string lights, collisions, loading screen | `public/scene/` ≤ 80 MB. Loads in < 20 s on 100 Mbit/s. Interactive ≥ 50 fps and refined ≤ 3 s on the reference machine. You can walk around without clipping through furniture. The owner reviews the spawn view at 50 mm f/1.8 and at 18 mm f/8 and agrees it looks photographic. |
| M7 | **Deploy** | `vercel.json` in place. The production URL works in the latest Chrome and Safari. README covers controls and credits. |

## 15. Known limitations and risks

1. **Sky softness at long focal lengths.** A 4K equirect gives ~11 px per degree; 55 mm on a 1500 px frame needs ~65. The courtyard geometry hides most of the sky. A later fix: an 8K sky-only texture.
2. **The thin-lens model leaves things out:** focus breathing, distortion, chromatic aberration, field curvature, cat's-eye/onion-ring bokeh and diffraction. Magnification at closest focus won't match the spec: the model gives 0.17× for the 50mm against Canon's 0.21×.
3. **Estimated values:** the 18-55 aperture breakpoints, vignetting amounts, bokeh roundness and EV100.
4. **Preview artefacts.** The interactive preview has artefacts at depth edges, and glass blurs only approximately. Refined mode is correct.
5. **Refinement cost** is roughly 256 × the scene's render cost. If it's too slow, lower the sample target or the resolution in `config.ts`.
6. **No metering.** EV100 is fixed per time of day, so pointing at the bright sky doesn't change the Av shutter speed.
7. **Night costs more.** Night and evening add ~30 lights, so each refinement sample costs more than at golden hour. Not yet measured on the reference machine.
8. **Shader compiles in Firefox.** Firefox has no `KHR_parallel_shader_compile`, so a shader query blocks the page until the shader is linked. Shaders are compiled for the right render target, then waited on with a fence (polling a fence doesn't block in Firefox), behind the loading screen or the old image (`compileShaders.ts`). Shadow-map depth, sky background and output shaders can't be compiled ahead, so the loading screen stays up over the first frame. Firefox and Safari have no GPU timer queries either; `?bench=1` measures rates and times instead.
9. **Night bokeh edges.** Bulbs at night are far above white, so even a few of the 256 samples saturate and disc edges look slightly scalloped. A higher sample target smooths them.

## 16. Adding cameras and lenses later

- **Body:** add an entry to `bodies.ts` with sensor width, aspect, image px, CoC (full frame: 0.030 mm) and `acceptsMounts` (a full-frame EF body takes `['EF']` only, so EF-S lenses are hidden). FOV, DoF, blur and frame lines all derive from these values.
- **Lens:** add an entry to `lenses.ts` with its aperture tables, and list any estimated values in `estimated`.
- **Further possibilities:** aspect-ratio crop modes per body, and adapters (e.g. EF/EF-S on RF bodies, with EF-S forcing crop mode). Both are new fields on the body and the mount check; the renderer doesn't change.

## 17. Sources

- Canon Camera Museum, EF50mm f/1.8 STM: https://global.canon/en/c-museum/product/ef451.html
- Canon Camera Museum, EF-S18-55mm f/4-5.6 IS STM: https://global.canon/en/c-museum/product/ef499.html
- Lenstip, EF-S 18-55 f/4-5.6 IS STM specifications: https://www.lenstip.com/1445-Canon_EF-S_18-55_mm_f_4-5.6_IS_STM-lens_specifications.html
- Wikipedia, Canon EF-S 18–55mm lens (angles of view): https://en.wikipedia.org/wiki/Canon_EF-S_18%E2%80%9355mm_lens
- Canon Asia, EOS 90D specifications: https://asia.canon/en/support/6200636100
- Poly Haven API (asset IDs and sizes checked 2026-11-11): https://api.polyhaven.com
- Vercel limits: https://vercel.com/docs/limits
- Haeberli & Akeley, "The Accumulation Buffer: Hardware Support for High-Quality Rendering", SIGGRAPH 1990
- Dennis Gustafsson, "Bokeh depth of field in a single pass", 2018
