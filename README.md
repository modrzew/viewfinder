# Viewfinder

Walk through a café courtyard at noon, golden hour, evening or night and see it the way a Canon EOS 90D would: the lens sets the framing, and the aperture and focus set the depth of field and bokeh. Hold still and the image refines from a fast preview to physically correct blur.

- Body: Canon EOS 90D (APS-C)
- Lenses: EF 50mm f/1.8 STM, EF-S 18-55mm f/4-5.6 IS STM
- Desktop browsers with mouse and keyboard; needs WebGL2 with `EXT_color_buffer_float`

See [SPEC.md](SPEC.md) for the optics model, rendering design and known limitations.

## Controls

| Input | Action |
|---|---|
| Click the view | Capture the mouse (Esc releases it) |
| Mouse | Look around |
| W A S D | Walk (hold Shift to hurry) |
| Q / E | Lower / raise eye height |
| Wheel | Zoom, zoom lenses only (Shift ×5) |
| `[` / `]` | Aperture wider / narrower by ⅓ stop |
| `−` / `=` | Focus nearer / farther (Shift ×10) |
| V | Camera view / eye view |
| X | Exposure mode Av / M |
| L | Next lens |
| T | Time of day: noon, golden hour, evening, night |
| R | Back to spawn |
| H | Help |

The panel on the right has the same controls plus a readout: focal length, field of view, f-number, shutter speed, focus distance, depth of field, hyperfocal distance and the distance to whatever is under the centre AF point.

Each time of day has its own sky and light level, so the Av shutter speed changes with it (ISO stays at 100). At noon the widest apertures need more than the 90D's 1/8000, so the image overexposes and the shutter speed blinks, as on the camera. An exposure locked in M carries over when you change the time of day. Golden hour loads with the scene; the other skies download the first time you pick them.

The counter in the top-left corner shows how many frames per second the GPU finishes, and their average CPU and GPU time. GPU time needs timer queries, which Chrome has and Safari and Firefox don't. Rendering follows `requestAnimationFrame`, so fps can't go above the display's refresh rate; GPU time shows how much headroom is left. Once a still image has finished refining, nothing is drawn and the counter reads idle.

URL options:

- `?scene=test` loads the optics test scene: distance cards from 0.5 to 32 m with point sources, and a 1 m card at 2.24 m that exactly fills the 50 mm frame.
- `?debug=1` adds the render mode and sample count to the fps counter, draws the predicted bokeh circle around the AF point, and lets keys 1–4 toggle the gather preview, refinement, vignetting and residual blur.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev        # Vite dev server
bun run build      # asset budget check, type check, production build into dist/
bun run lint
```

The scene assets in `public/scene/` are committed, so a fresh clone runs without downloading anything. To regenerate them:

```sh
bun run assets           # download from Poly Haven into .assets-cache/, optimise into public/scene/
bun run assets --force   # redo everything
```

`scripts/assets.manifest.ts` lists the assets and resolutions. Models go through `gltf-transform optimize` (meshopt geometry, WebP textures). `scripts/check-asset-budget.ts` fails the build if `public/scene/` grows past 80 MB.

Quality and performance constants (internal resolution, sample count, blur limits) live in `src/config.ts`.

## Deployment

A static site: point Vercel at the repository. It detects Vite and Bun from `package.json` and `bun.lock`, runs `bun run build` and serves `dist/`.

## Credits

All scene assets are CC0 from [Poly Haven](https://polyhaven.com). Credit isn't required, but thank you to the artists:

| Asset | Used for | Author(s) |
|---|---|---|
| [Outdoor Table Chair Set 01](https://polyhaven.com/a/outdoor_table_chair_set_01) | Café tables | James Ray Cock |
| [Tea Set 01](https://polyhaven.com/a/tea_set_01) | Teapot, cups, plates | James Ray Cock, Rico Cilliers, Jurita Burger |
| [Croissant](https://polyhaven.com/a/croissant) | Hero table | Greg Zaal, Dario Barresi |
| [Potted Plant 04](https://polyhaven.com/a/potted_plant_04) | Table plants | James Ray Cock |
| [Lantern 01](https://polyhaven.com/a/Lantern_01) | Table lanterns | Rajil Jose Macatangay |
| [Ceramic Vase 01](https://polyhaven.com/a/ceramic_vase_01) | Vases | James Ray Cock |
| [Wine Bottles 01](https://polyhaven.com/a/wine_bottles_01) | Bottles on the barrel | Rico Cilliers, Jurita Burger |
| [Gallinera Table](https://polyhaven.com/a/gallinera_table) | Bistro table | Ulan Cabanilla |
| [Gallinera Chair](https://polyhaven.com/a/gallinera_chair) | Bistro chairs | Ulan Cabanilla |
| [Potted Plant 01](https://polyhaven.com/a/potted_plant_01) | Large potted plants | Rico Cilliers |
| [Potted Plant 02](https://polyhaven.com/a/potted_plant_02) | Potted plants | Rico Cilliers |
| [Planter Box 01](https://polyhaven.com/a/planter_box_01) | West-side planters | James Ray Cock |
| [Shrub 03](https://polyhaven.com/a/shrub_03) | Planter shrubs | Rico Cilliers |
| [Flower Gazania](https://polyhaven.com/a/flower_gazania) | Planter flowers | James Ray Cock, Jenelle van Heerden |
| [Coffee Cart 01](https://polyhaven.com/a/CoffeeCart_01) | Coffee cart | Joe Seabuhr |
| [Street Lamp 01](https://polyhaven.com/a/street_lamp_01) | Post lamps | Josh Dean |
| [Street Lamp 02](https://polyhaven.com/a/street_lamp_02) | Wall lanterns | Josh Dean |
| [Painted Wooden Bench](https://polyhaven.com/a/painted_wooden_bench) | Bench | Kirill Sannikov |
| [Wine Barrel 01](https://polyhaven.com/a/wine_barrel_01) | Wine barrel | James Ray Cock |
| [Large Iron Gate](https://polyhaven.com/a/large_iron_gate) | Gate | Josh Dean |
| [Modular Urban Apartments Facade](https://polyhaven.com/a/modular_urban_apartments_facade) | Apartment facades | James Ray Cock |
| [Cobblestone Floor 06](https://polyhaven.com/a/cobblestone_floor_06) | Ground | Amal Kumar |
| [Clay Plaster](https://polyhaven.com/a/clay_plaster) | South wall | Amal Kumar |
| [Venice Sunset](https://polyhaven.com/a/venice_sunset) | Golden-hour sky and lighting | Greg Zaal |
| [Kloofendal 48d Partly Cloudy (Pure Sky)](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | Noon sky | Greg Zaal, Jarod Guest |
| [Qwantani Dusk 2 (Pure Sky)](https://polyhaven.com/a/qwantani_dusk_2_puresky) | Evening sky | Greg Zaal, Jarod Guest |
| [Qwantani Night (Pure Sky)](https://polyhaven.com/a/qwantani_night_puresky) | Night sky | Greg Zaal, Jarod Guest |

Rendering uses [three.js](https://threejs.org) and [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh). The depth-of-field techniques follow Haeberli & Akeley, "The Accumulation Buffer" (SIGGRAPH 1990), and Dennis Gustafsson, "Bokeh depth of field in a single pass" (2018).
