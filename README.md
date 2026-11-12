# HDRI Gradient Designer (ACEScg · Redshift)

Designs smooth, print-grade sky gradients (automotive-advert style) and exports them as
**ACEScg OpenEXR** environment maps for a Redshift dome light — with a live
preview that matches Redshift's ACES view transform.

```
start.bat            → http://127.0.0.1:8765
```
Needs Python 3 + numpy, a WebGL2 browser, and (for the Houdini buttons) the
FXHoudiniMCP plugin running in Houdini (see *Houdini settings*).

Nothing else to install or download: the **PRG Clear Sky** data ships with the app (`app/prg_data/`, see *Intensity*).
Reference photos (`refs/`) and exports (`output/`) aren't part of the repository.

## Workflow
1. Pick a preset (Golden Hour, Cream Daylight, Dusk Mauve, Overcast Lavender, Overcast Bright) or sample your own
   reference: **drop an image** anywhere on the app (or *Sample from reference… → Open image…*, or paste with Ctrl+V).
   The image is read locally in the browser — nothing is uploaded or saved.
   Click the horizon in a clean sky patch; the column above is sampled into stops. One image can give **both
   gradients**: the first click sets the *Sun side* column, the next the *Away side* column (both share the horizon
   line; shift-click moves only a column). With one column only, *One column → both sides* applies it linked.
2. Shape the **sun side** and **away side** gradients in the **Sky gradient** editor in the main view (the tracks show
   the stop gradient itself — the horizon/ground blend and Glow are added in the camera, dome and profile views;
   stops move in 0.01° steps; Flow keeps the 0° horizon stop's colour exactly) — both
   tracks at once (click a track to select its side, drag stops, click the strip below a gradient or double-click
   the gradient = add stop, double-click a stop = edit its colour, *Del* = remove the selected stop).
   *Link sides* for overcast skies. *Save preset…* opens a name field in the header (Enter = save; an existing
   preset's name overwrites it).
   **Colour picker** (any colour swatch, or double-click a stop): resizable at its corner, movable by its header.
   Shift-drag = 10× finer, wheel on a slider = ±1 step (Shift ×10), *Pick* = eyedropper, Esc = revert.
   * **Simple**: a plain sRGB picker (saturation × brightness square, hue strip, hex, R G B). What you pick is what
     you see; the app converts it to ACEScg internally (inverse of Redshift's *sRGB / ACES 1.0 SDR-video* view).
     If a colour is too vivid/bright for the ACES view, it says so and shows what it *renders as*.
   * **Advanced** adds: the *OkLCh* plane — **Lightness** (0 black … 100 white) × **Chroma** (colourfulness at the
     same lightness: 0 = grey, higher = more vivid; sky colours are mostly 0.01–0.07, the most vivid sRGB colours
     ~0.3) at the current **Hue**. It's the space the gradient is interpolated in, so equal steps look equal.
     *Chroma zoom* (0–0.04 … all) spreads a small chroma range over the whole field for subtle sky colours.
     The **ACEScg** row shows what the colour becomes in the HDRI at EV 0 / dome intensity 1 (same LUTs as the
     export, matches the shader exactly) — type ACEScg values from Redshift/Nuke to get the matching display colour.
     Grey = outside sRGB; greyed-out = inside sRGB but the ACES view can't produce it (bright, saturated edge, deep
     blues, display values above 0.985). The blue hues show a thin separate sliver below the main shape — that is
     the real shape of sRGB in OkLCh, not an error.
   Final brightness always comes from the light model and camera exposure unless *Lightness from colour stops* > 0.
   **Undo / Redo** (header buttons, *Ctrl+Z* / *Ctrl+Y* or *Ctrl+Shift+Z*) covers every design setting —
   stops, colours, sliders, light, sun, preset loads. A whole drag is one step; camera framing is not included.
3. Under the tracks: *Horizon spread* sets the real-sky curvature, *Flow* the smoothing (see below),
   *Side blend falloff* how fast the sun side turns into the away side around the dome.
4. Frame the backdrop — without Houdini: drag in the **Camera view** to pan, mouse wheel to zoom; or drag the
   **border** of the white camera frame on the **Full dome** view (it highlights on hover). Clicking or dragging
   anywhere else — also inside the frame — places the sun; the sun marker always wins where it overlaps the border. *Lens mm* +
   film back and *Format* (2.39:1 … 2:3) set the crop. Moving the camera view never re-meters (also not with
   *Lock exposure* off, which only reacts to light / design changes) — use *Meter* for a new reading.
   With Houdini: *Sync from Houdini* reads lens, pitch and look direction from the scene camera.
5. *Export + send to dome* → creates/updates `/obj/HDRI_Designer_Dome`
   (and `/obj/HDRI_Designer_Dome_Sun`), switches off the scene's own dome lights,
   sets the dome's Camera contribution and the camera Exposure (EV). Render in Houdini as usual.
   To go back, switch your own dome on again in Houdini (it's marked with userData `hdri_designer_disabled`).

## Houdini settings (for any Houdini user)
*Houdini settings…* (Houdini panel, or click the Houdini status pill in the header) — saved in `app/settings.json`:
* **Connection**: host + port of FXHoudiniMCP (default `127.0.0.1:8100`), *Test connection* shows the Houdini
  version and the open scene. Different ports reach different Houdini sessions.
* **Scene**: the camera (for *Sync from Houdini* and the exposure on *Send*), the dome node name in `/obj`, the
  dome's Y rotation, and whether *Send* switches off other dome lights / sets the camera's Redshift Exposure.
* **Setup for a new user** (also shown on the page):
  1. Houdini + Redshift on the same computer as the app (Houdini reads the EXR from `output/`), Redshift's default
     OCIO config (ACEScg, *sRGB / ACES 1.0 SDR-video*).
  2. Install FXHoudiniMCP (MIT, github.com/healkeiser/fxhoudinimcp) — it adds a Houdini package
     (`Documents/houdiniXX.X/packages/fxhoudinimcp.json`) with a small local web server inside Houdini.
  3. In that package: `FXHOUDINIMCP_PORT` (default 8100), `FXHOUDINIMCP_BIND` (127.0.0.1), `FXHOUDINIMCP_AUTOSTART` = 1.
  4. Start Houdini, open the scene, enter host / port, *Test connection*.
  5. Pick the camera → *Sync from Houdini* → *Export + send to dome*.
* Limits: OBJ-level Redshift lights only (no Solaris / LOPs yet); the designer only creates/replaces its own dome.

## Colour pipeline
* Stops are **display colours** — what you'll see through Redshift's
  *sRGB / ACES 1.0 SDR-video* view at dome intensity 1, exposure 0.
* Per pixel: stops → OkLab → curve → side blend → horizon/ground → glow (screen, display space)
  → **inverse ACES view (exact OCIO LUT from Redshift's own config)** → ACEScg × 2^EV → + HDR sun.
* LUTs: `app/static/luts`, baked from `C:/Program Files/Maxon Redshift 2026/Data/OCIO/config.ocio`
  by `tools/bake_luts.py` (run inside Houdini). Re-bake if the OCIO config changes.
* EXR: always **32-bit float**, ZIP, chromaticities = ACES AP1. 2K / 4K / 8K / **16K** (16384×8192, ~0.9 GB for a
  smooth sky; needs a GPU that renders 16384 px wide — checked before export). The writer streams block by block,
  so memory stays at one image (1.6 GB at 16K).
* **Profile** view can show: display through the current View, ACES 1.0 SDR, Un-tone-mapped, or the **ACEScg 32-bit
  float values** written to the EXR (Redshift units, before camera exposure) on a log axis, one line per stop.
  Dome texture colour space is set to **ACEScg**.
* Verified: stops reproduce to 0/255 through exact OCIO; app preview vs Redshift render within ±1/255.

## Smoothness ("flow")
Banding in subtle gradients comes from curvature jumps, not from bit depth. The curve is
1. placed in **optical air-mass space** (Kasten–Young; the Perez gradation term) so colour changes
   fast near the horizon and flattens toward the zenith like a real sky (*Horizon spread*),
2. interpolated monotonically (no overshoot), then **Gaussian-smoothed** on the √elevation axis (*Flow*)
   → C∞, no Mach bands at stops. *Flow = 0* passes exactly through the stops.
Glow (Cauchy aureole), horizon (softplus + quintic blend) and zenith convergence are all smooth.
The **Profile** panel shows exact design values; the white *flow* curve is |dL| — it should be one
smooth hump without corners. Measured ripple in the exported EXR: ~0.05–0.1 of an 8-bit code (RMS).

## Colour and intensity are separate
* **Colour** = the gradient stops (hue/saturation; their lightness is ignored unless
  *Lightness from colour stops* > 0).
* **Intensity** = physics:
  * **Clear skies — PRG Clear Sky (default):** the Prague sky model (Wilkie et al. 2021, Vevoda et al. 2022), also
    Redshift's default *Physical Sky* model. Absolute sky luminance over the whole dome and the sun's direct-normal
    illuminance follow from sun elevation (−4.2°…90°; below that the twilight falloff continues), **visibility**
    (20 km hazy … 132 km very clear) and ground albedo. The local server evaluates the model for the exact values
    (`app/prg_service.py`, ~0.03 s) — a numpy port of the Apache-2.0 reference code (`tools/prg/prague_sky.py`),
    checked against the compiled C++ reference to < 1e-8. Spectra → luminance with the CIE 1931 ȳ
    (`tools/prg/prg_weights.json`). Data: `app/prg_data/` (~40 MB, included) — the part of the Prague dataset
    (`PragueSkyModelDatasetGround.dat`, 107.6 MB, [Zenodo record 19140728](https://zenodo.org/records/19140728),
    Apache 2.0) the designer evaluates: the luminance channels and the ground-level sun transmittance, values
    unchanged, xz-compressed. `tools/prg/build_bundle.py` rebuilds it from the full file and `--verify` checks it
    gives identical results. If the folder is missing the app falls back to the full `.dat` in `tools/prg/`, then
    to CIE / IES.
  * **CIE (overcast, partly cloudy, or chosen for clear):** sky luminance *distribution* from CIE S 011 / ISO 15469
    (15 standard skies); *level*: horizontal sky and direct-normal sun illuminance from the IES RP-21 daylight model
    (extinction adjustable; twilight falloff below 0°); untick *Lux from sun elevation* to type values;
  * sun disc: real 0.53° by default; radiance = E⊥ / Ω, with Ω measured on the rasterised disc at the export
    resolution, so the file delivers exactly the requested lux at any size/softness;
  * ground: Lambertian, albedo × (sky + sun) / π.

## Absolute units in Redshift (measured)
* A 1000-nit Redshift area light renders as 1.464 → **1.0 Redshift unit = 683 cd/m²**. HDRIs are written as cd/m² / 683.
* Camera *Exposure (EV)* multiplies by 2^EV. With an 18 % grey card ⇒ mid grey: **EV100 = 9.94 − RS EV**.
* Verified on export (golden hour preset): sky EXR integrates to 4 894 lx (target 4 900), sun EXR to 9 579 lx (target 9 600).

## Exposure (one physical dome)
Four controls, for any subject (car, product, person, building):
* **Lock exposure** (on by default and in every built-in preset) — on: the camera EV stays where you set it.
  Off: auto exposure — the EV follows the meter whenever the light or the design changes (sun, sky model,
  visibility, colours …); moving the camera never re-meters. The EV slider and *Meter* are greyed out while it's off.
* **Camera exposure EV** — Redshift's camera *Exposure (EV)*, sent as is; **+ = brighter** (like Background).
  The readout also shows it as photographic EV100 (= 9.94 − RS EV; higher EV100 = darker). It's a plain setting
  like on a real camera: it only changes when you move it or press *Meter*, so light changes show their real
  brightness change.
* **Meter** — sets the camera exposure from an incident reading: light falling on a subject that faces the camera
  (sky + sun), 18 % grey → mid grey. The built-in presets start at exposure 0. Done automatically on loading a
  preset that has no exposure stored (none of the built-in ones) and
  *Sync from Houdini*; the hint next to it shows what the meter reads now. Moving the camera view never meters.
* **Background EV vs the colour design** — 0 = the sky in frame looks as designed, automatically, at any exposure
  and sun position; − darker / + brighter than the design. The app sets the dome's **Camera contribution**
  (`RSL_cameraScale`, primary rays only; values above 1 work) to whatever that takes. Lighting, reflections and
  refractions always keep their physical values.
* The readout shows the camera EV and EV100, and the Camera contribution with how far it is from the physical sky.
* *Send* sets `RS_campro_PyCamExposureType = EV only` and the EV on the chosen camera (the original value is kept in
  the camera's userData `hdri_designer_orig_ev`). Scene emissives (lamps, LEDs) must be in physical units too —
  e.g. Redshift lights in Nits — to balance.
* The sun dome always has Background off and Camera contribution 0 (Redshift uses the Camera scale for
  primary visibility; Background off alone does not hide a dome).
* *Send* **recreates** the designer domes every time: in a running session Redshift can keep stale per-light
  texture data when an existing dome's map / visibility changes (seen as a smeared, too-dark background).
  Preview vs. Redshift render after the fix: within ±2/255 across the frame.

## Redshift intensity clamps
Default ROP clamps (*Max Subsample Intensity* and *Max Secondary Ray Intensity* = 4.0) clip physical sky and
especially sun **reflections** in paint/chrome/glass. Raise them on the Redshift ROP in Houdini if needed (e.g. to
100000). Expect more fireflies on very glossy materials without clamps — increase samples rather than clamping if possible.

## Sun
**Physical sun colour (PRG)** (default on, clear skies with PRG): the disc colour comes from the Prague model's sun
spectrum after the atmosphere (CIE XYZ → ACEScg), so it shifts from ≈ 5300 K high up to orange and deep red near
the horizon, and redder in hazy air (lower visibility). The info line shows a swatch and the colour temperature.
Off — or with CIE skies — the *Colour* swatch is used. Brightness is unchanged (always the model's / chosen lux).

*Baked into the sky HDRI* (default): the sun disc is part of the one sky EXR (32-bit float) — one dome lights,
reflects and shows the sun. *Separate sun dome* instead writes `*_sun.exr` onto a second dome hidden from camera,
so the sun lights and reflects but never shows as a disc in the plate.

## Orientation
Measured by rendering a UV-coded HDRI through Redshift: equirect azimuth 0 (image centre) = world −Z,
+azimuth → +X; texture azimuth = world azimuth + dome *ry*. Elevation maps 1:1.

## Files
`app/server.py` server · `app/exr.py` EXR writer · `app/houdini_bridge.py` Houdini RPC ·
`app/static/app.js` shader + UI · `app/presets/*.json` presets · `output/` exports (versioned) + renders.
