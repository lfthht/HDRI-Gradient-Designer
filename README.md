# HDRI Gradient Designer

**Smooth, physically lit sky HDRIs for Maxon Redshift — designed in the browser, delivered as ACEScg OpenEXR.**

Design the colour of a sky as two gradients (sun side and away side), and let a physical sky model supply the
brightness. The live preview matches Redshift's *ACES 1.0 SDR-video* view, and one click sends the result to a dome
light in Houdini. Built for automotive and product backdrops, where a sky has to be smooth enough for print.

- 🎨 **Two-track gradient editor** — sun side and away side, OkLab interpolation, banding-free "flow" smoothing
- ☀️ **Physical light** — [Prague sky model](https://github.com/PetrVevoda/pragueskymodel) (Redshift's default
  *Physical Sky*) or CIE standard skies, absolute units, sun disc baked into the HDRI
- 🎞️ **Exact ACES preview** — Redshift's own OCIO config baked into LUTs, matches renders within ±1/255
- 📷 **Camera framing and exposure** — lens, film back and format crop; Redshift EV with a light meter and lock
- 🖍️ **Colour picker for ACES** — sRGB or OkLCh, ACEScg values, and a warning when the ACES view can't show a colour
- 🖼️ **Sample from a photo** — drop a reference image and click the horizon to get both gradients
- 💾 **32-bit float EXR** up to 16K (16384 × 8192)
- 🔌 **Houdini link** through [FXHoudiniMCP](https://github.com/healkeiser/fxhoudinimcp) — sync the camera,
  create the dome, set the exposure

---

## Quick start

**Needs:** Python 3 with `numpy`, and a browser with WebGL2 (Chrome, Edge, Firefox). Houdini is optional — the app
exports EXRs on its own.

```bash
git clone https://github.com/lfthht/HDRI-Gradient-Designer.git
cd HDRI-Gradient-Designer
pip install numpy
```

**Windows:** double-click `start.bat` — it starts the local server and opens <http://127.0.0.1:8765>.
**Any system:** `cd app` then `python server.py`, and open <http://127.0.0.1:8765>.

That's all: the Prague sky data ships with the app (`app/prg_data/`, 40 MB), nothing else to download.
Everything runs locally; reference images you drop in are read in the browser and never uploaded.

## Connect Houdini (optional)

The Houdini buttons (*Sync from Houdini*, *Export + send to dome*) talk to Houdini through
**[FXHoudiniMCP](https://github.com/healkeiser/fxhoudinimcp)** (MIT) — a Houdini package that runs a small local web
server inside Houdini.

1. Houdini + Redshift on the same computer as the app (Houdini reads the EXR from `output/`), with Redshift's default
   OCIO config (ACEScg, *sRGB / ACES 1.0 SDR-video*).
2. Install [FXHoudiniMCP](https://github.com/healkeiser/fxhoudinimcp#installation). It adds a package file
   `Documents/houdiniXX.X/packages/fxhoudinimcp.json`; set in it:
   `FXHOUDINIMCP_PORT` = `8100` · `FXHOUDINIMCP_BIND` = `127.0.0.1` · `FXHOUDINIMCP_AUTOSTART` = `1`.
3. Start Houdini and open your scene.
4. In the designer: **Houdini settings…** (Houdini panel, or click the Houdini status pill in the header) → enter
   host and port → **Test connection** (shows the Houdini version and the open scene).
5. Pick the scene camera → **Sync from Houdini** → design → **Export + send to dome**.

**Houdini settings** (saved in `app/settings.json`, not in the repository):

| Setting | What it does |
| --- | --- |
| Host / port | Where FXHoudiniMCP listens (default `127.0.0.1:8100`). Different ports reach different Houdini sessions. |
| Camera | Used by *Sync from Houdini* and for the exposure on *Send*. |
| Dome name | The node the designer creates in `/obj`. |
| Dome Y rotation | Keeps the designer's azimuth aligned with your scene. |
| Switch off other domes | *Send* disables the scene's own dome lights (marked with userData `hdri_designer_disabled`; switch them back on to return). |
| Set camera exposure | *Send* sets the camera's Redshift Exposure (EV); the original is kept in userData `hdri_designer_orig_ev`. |

*Send* creates or updates `/obj/HDRI_Designer_Dome` (and `/obj/HDRI_Designer_Dome_Sun` with a separate sun) and
sets the dome's Camera contribution and the camera exposure. Then render in Houdini as usual.
Limits: OBJ-level Redshift lights only (no Solaris / LOPs yet); the designer only creates or replaces its own domes.

## Workflow

1. **Start from a preset** — Golden Hour, Cream Daylight, Dusk Mauve, Overcast Lavender, Overcast Bright — **or a
   photo**: drop an image anywhere on the app (or *Sample from reference… → Open image…*, or paste with Ctrl+V).
   Click the horizon in a clean sky patch: the first click samples the *sun side* column, the next the *away side*
   (both share the horizon line; Shift-click moves only a column). With one column, *One column → both sides*.
2. **Shape the gradients** in the *Sky gradient* editor (both tracks are live):
   - click a track to select its side · drag stops (0.01° steps) · click the strip below a gradient, or double-click
     the gradient, to add a stop · double-click a stop to edit its colour · <kbd>Del</kbd> removes the selected stop
   - *Link sides* for overcast skies · *Horizon spread* = real-sky curvature · *Flow* = smoothing ·
     *Side blend falloff* = how fast the sun side turns into the away side around the dome
   - **Undo / Redo** (<kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>) covers every design setting;
     a whole drag is one step, camera framing is not included
   - *Save preset…* opens a name field in the header (Enter saves; an existing name overwrites)
3. **Set the light** — sky model, visibility, sun position (click or drag on the *Full dome* view).
4. **Frame the backdrop** — drag in the *Camera view* to pan, wheel to zoom, or drag the border of the camera frame
   on the *Full dome* view. *Lens mm*, film back and *Format* (2.39:1 … 2:3) set the crop.
5. **Expose** — see [Exposure](#exposure).
6. **Export** a 32-bit float EXR (2K–16K), or *Export + send to dome* with Houdini.

### Colour picker

Opens from any colour swatch or by double-clicking a stop. Resize it at its corner, move it by its header.
Shift-drag = 10× finer, wheel on a slider = ±1 step (Shift ×10), *Pick* = eyedropper, <kbd>Esc</kbd> = revert.

- **Simple** — a plain sRGB picker. What you pick is what you see; the app converts it to ACEScg internally (inverse
  of Redshift's *sRGB / ACES 1.0 SDR-video* view). If a colour is too vivid or bright for the ACES view, it says so
  and shows what it renders as.
- **Advanced** — adds the **OkLCh** plane: *Lightness* (0 black … 100 white) × *Chroma* (0 = grey; sky colours are
  mostly 0.01–0.07, the most vivid sRGB colours ≈ 0.3) at the current *Hue* — the space the gradient is
  interpolated in. *Chroma zoom* spreads a small chroma range over the whole field. The **ACEScg** row shows the
  value written to the HDRI at EV 0 / dome intensity 1; type ACEScg values from Redshift or Nuke to get the matching
  display colour. Grey = outside sRGB; greyed out = inside sRGB but not reachable through the ACES view.

## Exposure

| Control | Meaning |
| --- | --- |
| **Lock exposure** | On (default, and in every preset): the camera EV stays where you set it, so light changes show their real brightness. Off: auto exposure — the EV follows the meter whenever the light or the design changes. Moving the camera never re-meters. |
| **Camera exposure EV** | Redshift's camera *Exposure (EV)*, sent as is; **+ = brighter**. The readout also shows photographic EV100 (= 9.94 − RS EV). |
| **Meter** | Sets the EV from an incident reading — light falling on a subject that faces the camera, 18 % grey → mid grey. Also done on *Sync from Houdini* and for presets without a stored exposure. |
| **Background EV vs the colour design** | 0 = the sky in frame looks exactly as designed, at any exposure and sun position. The app sets the dome's **Camera contribution** (`RSL_cameraScale`, primary rays only; above 1 works) to match. Lighting, reflections and refractions always stay physical. |

One physical dome lights, reflects and shows the sky — no separate backplate. Scene emissives (lamps, LEDs) should
be in physical units too (e.g. Redshift lights in nits) to balance.

## Light models

- **PRG Clear Sky (default for clear skies)** — the Prague sky model (Wilkie et al. 2021, Vévoda et al. 2022), also
  Redshift's default *Physical Sky*. Absolute sky luminance over the whole dome and the sun's direct-normal
  illuminance from sun elevation (−4.2° … 90°, twilight falloff below), **visibility** (20 km hazy … 132 km very
  clear) and ground albedo. Evaluated by the local server (`app/prg_service.py`, ~0.03 s) with a numpy port of the
  Apache-2.0 [reference code](https://github.com/PetrVevoda/pragueskymodel) (`tools/prg/prague_sky.py`), checked
  against the compiled C++ reference to < 1e-8. Spectra → luminance with the CIE 1931 ȳ.
- **CIE (overcast, partly cloudy, or chosen for clear)** — luminance distribution from CIE S 011 / ISO 15469
  (15 standard skies); level from the IES RP-21 daylight model (extinction adjustable), or typed lux values.
- **Sun** — real 0.53° disc by default; radiance = E⊥ / Ω with Ω measured on the rasterised disc at the export
  resolution, so the file delivers exactly the requested lux at any size and softness.
  *Baked into the sky HDRI* (default) puts the disc in the one sky EXR; *Separate sun dome* writes `*_sun.exr` to a
  second dome hidden from camera. **Physical sun colour** (PRG) takes the disc colour from the model's sun spectrum
  after the atmosphere — ≈ 5300 K high up, orange to deep red near the horizon, redder in hazy air.
- **Ground** — Lambertian, albedo × (sky + sun) / π.
- **Colour and intensity are separate:** the stops set hue and saturation; brightness comes from the light model and
  the exposure (unless *Lightness from colour stops* > 0).

<details>
<summary><b>Technical notes</b> — colour pipeline, smoothness, units, orientation</summary>

### Colour pipeline
- Stops are **display colours** — what you see through Redshift's *sRGB / ACES 1.0 SDR-video* view at dome
  intensity 1, exposure 0.
- Per pixel: stops → OkLab → curve → side blend → horizon/ground → glow (screen, display space) →
  **inverse ACES view** (exact 97³ LUT from Redshift's own OCIO config) → ACEScg × 2^EV → + HDR sun.
- LUTs in `app/static/luts`, baked from `Maxon Redshift 2026/Data/OCIO/config.ocio` by `tools/bake_luts.py` (run
  inside Houdini). Re-bake if the OCIO config changes.
- EXR: always **32-bit float**, ZIP, chromaticities ACES AP1; the dome texture colour space is ACEScg. 16K
  (≈ 0.9 GB for a smooth sky) needs a GPU that renders 16384 px wide — checked before export. The writer streams
  block by block, so memory stays at one image (1.6 GB at 16K).
- **Profile** view: display through the current view, ACES 1.0 SDR, un-tone-mapped, or the ACEScg 32-bit float
  values written to the EXR on a log axis.
- Verified: stops reproduce to 0/255 through exact OCIO; preview vs Redshift render within ±1/255
  (±2/255 across the frame with the dome).

### Smoothness ("flow")
Banding in subtle gradients comes from curvature jumps, not from bit depth. The curve is
1. placed in **optical air-mass space** (Kasten–Young; the Perez gradation term), so colour changes fast near the
   horizon and flattens toward the zenith like a real sky (*Horizon spread*),
2. interpolated monotonically (no overshoot), then **Gaussian-smoothed** on the √elevation axis (*Flow*) → C∞, no
   Mach bands at stops. *Flow = 0* passes exactly through the stops.

Glow (Cauchy aureole), horizon (softplus + quintic blend) and zenith convergence are smooth too. In the *Profile*
panel the white *flow* curve is |dL| — it should be one smooth hump without corners. Measured ripple in the exported
EXR: ~0.05–0.1 of an 8-bit code (RMS).

### Absolute units in Redshift (measured)
- A 1000-nit Redshift area light renders as 1.464 → **1 Redshift unit = 683 cd/m²**; HDRIs are written as cd/m² / 683.
- Camera *Exposure (EV)* multiplies by 2^EV; with an 18 % grey card → mid grey: **EV100 = 9.94 − RS EV**.
- Golden-hour export check: sky EXR integrates to 4 894 lx (target 4 900), sun EXR to 9 579 lx (target 9 600).

### Redshift specifics
- *Send* sets `RS_campro_PyCamExposureType` = *EV only* and the EV on the chosen camera.
- The sun dome always has Background off and Camera contribution 0 (Background off alone does not hide a dome).
- *Send* **recreates** the designer domes every time: Redshift can keep stale per-light texture data when an existing
  dome's map or visibility changes in a running session (seen as a smeared, too-dark background).
- Default ROP clamps (*Max Subsample Intensity* / *Max Secondary Ray Intensity* = 4) clip physical sky and especially
  sun **reflections** in paint, chrome and glass. Raise them on the Redshift ROP if needed (e.g. 100000) and add
  samples against fireflies.

### Orientation
Measured with a UV-coded HDRI rendered through Redshift: equirect azimuth 0 (image centre) = world −Z, +azimuth → +X;
texture azimuth = world azimuth + dome *ry*. Elevation maps 1:1.

### Prague sky data
`app/prg_data/` (40 MB) is the part of the Prague dataset (`PragueSkyModelDatasetGround.dat`, 107.6 MB,
[Zenodo record 19140728](https://zenodo.org/records/19140728)) the designer evaluates — the luminance channels and the
ground-level sun transmittance, values unchanged, xz-compressed. `tools/prg/build_bundle.py` rebuilds it from the
full file and `--verify` checks the results are identical. Without the folder the app falls back to the full `.dat`
in `tools/prg/`, then to CIE / IES.

</details>

## Project layout

| Path | Contents |
| --- | --- |
| `start.bat` | Starts the server and opens the UI (Windows) |
| `app/server.py` | Local web server and API |
| `app/static/` | UI — `app.js` (WebGL2 shader + UI), `colorpicker.js`, `index.html`, `style.css`, ACES LUTs |
| `app/prg_service.py`, `app/prg_data/` | Prague sky model evaluation and its data |
| `app/exr.py` | Streaming 32-bit float EXR writer |
| `app/houdini_bridge.py` | Houdini calls through FXHoudiniMCP |
| `app/presets/` | Built-in presets (JSON) |
| `tools/` | LUT baking, Prague model port, data bundling, reference comparison |
| `output/` | Exports (created on first export; not in the repository) |

## Credits

- **Prague Sky Model** — Wilkie et al.,
  [*A Fitted Radiance and Attenuation Model for Realistic Atmospheres*](https://cgg.mff.cuni.cz/publications/skymodel-2021/),
  ACM TOG 40(4) (SIGGRAPH 2021); Vévoda et al.,
  [*A Wide Spectral Range Sky Radiance Model*](https://cgg.mff.cuni.cz/publications/infrared-skymodel-2022/),
  Computer Graphics Forum 41(7), 2022.
  [Code](https://github.com/PetrVevoda/pragueskymodel) and [data](https://zenodo.org/records/19140728),
  © Charles University, Apache 2.0 — see `app/prg_data/NOTICE.txt` and `tools/prg/ref/LICENSE.txt`.
- **[FXHoudiniMCP](https://github.com/healkeiser/fxhoudinimcp)** by Valentin Beaumont (healkeiser), MIT — the Houdini
  bridge.
- **[OkLab](https://bottosson.github.io/posts/oklab/)** by Björn Ottosson — the perceptual colour space for the
  gradients and the picker.
- **ACES / OpenColorIO** — the view transform comes from the OCIO config shipped with Maxon Redshift.
- CIE S 011 / ISO 15469 standard skies, IES RP-21 daylight model, CIE 1931 colour matching functions.
