/* HDRI Gradient Designer — front end.
 *
 * Pipeline per direction (identical for preview and export, it is one shader):
 *   stops (display sRGB hex) → OkLab → monotone-cubic interpolation over elevation
 *   → sun-side / away-side blend by azimuth → ground + horizon blend → saturation
 *   → display code values → glow (screen blend) → inverse view transform (exact OCIO LUT)
 *   → ACEScg scene-linear × 2^EV → + HDR sun disc  ==> EXR
 *   preview: ACEScg → forward view transform LUT → canvas
 */
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const MAX_STOPS = 16;

// ------------------------------------------------------------------ colour math (JS mirror)
const srgbDecode = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const srgbEncode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055);
function hexToRgb(h) {
  h = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.substr(i, 2), 16) / 255);
}
function rgbToHex(c) {
  return "#" + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0")).join("");
}
function linToOklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToLin([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const hexToLab = (h) => linToOklab(hexToRgb(h).map(srgbDecode));
const labToHex = (lab) => rgbToHex(oklabToLin(lab).map((v) => srgbEncode(Math.max(0, v))));
// linear Rec.709 → ACEScg (AP1), Bradford D65→D60 (same matrix as the ACES OCIO config)
const M709_AP1 = [[0.613097, 0.339523, 0.047379], [0.070194, 0.916354, 0.013452], [0.020616, 0.10957, 0.869815]];
const mul3 = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const AP1_Y = [0.2722287, 0.6740818, 0.0536895];

// Fritsch–Carlson monotone cubic tangents (no overshoot → no ringing / bands)
function monoTangents(xs, ys, zeroEnd) {
  const n = xs.length, m = new Array(n).fill(0);
  if (n < 2) return m;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-12) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  if (zeroEnd) m[n - 1] = 0; // C1 across the zenith
  return m;
}

// ------------------------------------------------------------------ default parameters
function defaultParams() {
  return {
    version: 1,
    A: [{ e: 0, c: "#c0a186" }, { e: 3, c: "#c2a68c" }, { e: 10, c: "#c7bbaa" }, { e: 30, c: "#a3abae" }, { e: 90, c: "#8794a0" }],
    B: [{ e: 0, c: "#a9a2a2" }, { e: 10, c: "#acaaad" }, { e: 30, c: "#9ea5ad" }, { e: 90, c: "#8794a0" }],
    link: false,
    sideBlend: 1.5,
    curve: { spread: 0.3, flow: 0.035 },
    horizon: { offset: 0, softness: 0.6 },
    ground: { top: "#6d6a66", bottom: "#3d3c3b", falloff: 15 },
    glow: { color: "#ffc890", strength: 0.15, width: 20, band: 0.2, bandHeight: 5 },
    // physColor: with PRG, the disc colour comes from the model's sun spectrum (changes with elevation / visibility)
    sun: { az: 0, el: 2, disc: true, mode: "baked", color: "#ffd9a8", physColor: true, size: 0.53, softness: 0.15 },
    // intensity — independent of colour. Clear skies: Prague sky model (PRG, physically based: absolute sky
    // luminance + sun from sun elevation, visibility and ground albedo). Otherwise / "cie": CIE sky distribution +
    // IES daylight lux (unless auto is off).
    light: { condition: "clear", model: "prg", visibility: 59.4, cie: "12", auto: true, skyLux: 10000, sunLux: 50000,
             extinction: 0.21, stopsLightness: 0, anchorEl: 2, albedo: 0.2 },
    // exposure: ev = the Redshift camera Exposure (EV), + brighter (Meter sets it from a reading; also done on
    // preset load / Houdini sync when a preset has none) and the background = physical sky ± bgOffset EV
    // (dome Camera contribution 2^bgOffset) — both: + = brighter
    // lock: true = the EV stays where it is set; false = auto exposure — the EV follows the meter whenever the light
    // or the design changes (camera moves never re-meter)
    exp: { ev: 0, bgOffset: 0, bgRef: "design", lock: true },
    saturation: 1, grain: 0,
  };
}
const deepCopy = (o) => JSON.parse(JSON.stringify(o));
function mergeDefaults(p) {
  const d = defaultParams();
  const out = Object.assign(d, deepCopy(p));
  for (const k of ["curve", "horizon", "ground", "glow", "sun", "light", "exp"]) out[k] = Object.assign(defaultParams()[k], p[k] || {});
  // older exposure settings: metering modes, compensation and background modes are gone; the background offset is
  // now relative to the colour design (bgRef "design") — older offsets (relative to physical) start at 0 = as designed
  if (!p.exp || p.exp.bgRef !== "design") out.exp.bgOffset = 0;
  out.exp.bgRef = "design";
  for (const k of ["background", "meter"]) delete out.exp[k];
  // EV100 (higher = darker) was replaced by the Redshift camera EV (+ = brighter): RS EV = 9.94 − EV100
  if (typeof (p.exp || {}).ev !== "number" && typeof (p.exp || {}).ev100 === "number") out.exp.ev = +(EV100_OFFSET - p.exp.ev100).toFixed(2);
  delete out.exp.ev100;
  delete out.light.exposureMode;
  delete out.exposure;
  return out;
}
// a preset without its own EV100 gets a meter reading when it's loaded
const presetHasEV = (p) => !!(p && p.exp && (typeof p.exp.ev === "number" || typeof p.exp.ev100 === "number"));

// ------------------------------------------------------------------ photometry
// Redshift: 1.0 render unit = 683 cd/m² (measured: a 1000-nit RS area light renders as 1.464),
// camera "Exposure (EV)" multiplies by 2^EV (measured). Reflected-light meter (K=12.5, ISO 100):
// mid-grey 0.18 ↔ L = 0.125·2^EV100  ⇒  EV100 = log2(0.18·683/0.125) − RS_EV = 9.942 − RS_EV.
const RS_NITS = 683;
const EV100_OFFSET = Math.log2((0.18 * RS_NITS) / 0.125);
// CIE S 011 / ISO 15469 standard general skies: [a, b, c, d, e, name]
const CIE_SKIES = {
  1: [4.0, -0.7, 0, -1.0, 0.0, "Overcast, steep gradation (CIE overcast)"],
  2: [4.0, -0.7, 2, -1.5, 0.15, "Overcast, steep, slight brightening to sun"],
  3: [1.1, -0.8, 0, -1.0, 0.0, "Overcast, moderate gradation"],
  4: [1.1, -0.8, 2, -1.5, 0.15, "Overcast, moderate, slight brightening to sun"],
  5: [0.0, -1.0, 0, -1.0, 0.0, "Uniform sky"],
  6: [0.0, -1.0, 2, -1.5, 0.15, "Partly cloudy, slight brightening to sun"],
  7: [0.0, -1.0, 5, -2.5, 0.3, "Partly cloudy, brighter circumsolar"],
  8: [0.0, -1.0, 10, -3.0, 0.45, "Partly cloudy, distinct corona"],
  9: [-1.0, -0.55, 2, -1.5, 0.15, "Partly cloudy, obscured sun"],
  10: [-1.0, -0.55, 5, -2.5, 0.3, "Partly cloudy, brighter circumsolar"],
  11: [-1.0, -0.55, 10, -3.0, 0.45, "White-blue sky, distinct corona"],
  12: [-1.0, -0.32, 10, -3.0, 0.45, "Clear, low turbidity (CIE clear)"],
  13: [-1.0, -0.32, 16, -3.0, 0.3, "Clear, polluted / hazy"],
  14: [-1.0, -0.15, 16, -3.0, 0.3, "Cloudless turbid, broad corona"],
  15: [-1.0, -0.15, 24, -2.8, 0.15, "White-blue turbid sky"],
};
// IES RP-21 daylight availability (klx): sky on a horizontal plane + direct-normal sun; twilight below 0°.
function daylight(cond, el, ext) {
  const m = 1 / (Math.sin((Math.max(0, el) * Math.PI) / 180) + 0.50572 * Math.pow(Math.max(0, el) + 6.07995, -1.6364));
  const sa = Math.sin((Math.max(0, el) * Math.PI) / 180);
  let sky, sun;
  if (cond === "overcast") { sky = 0.3 + 21.0 * sa; sun = 0; }
  else if (cond === "partly") { sky = 0.3 + 45.0 * sa; sun = 127.5 * Math.exp(-0.8 * m); }
  else { sky = 0.8 + 15.5 * Math.sqrt(sa); sun = 127.5 * Math.exp(-ext * m); }
  if (el < 0) { sky *= Math.pow(10, 0.38 * el); sun = 0; }      // civil twilight falloff (~4 lx at −6°)
  return { sky: sky * 1000, sun: sun * 1000 };
}
const fmtLux = (v) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + " klx" : v.toFixed(v < 10 ? 1 : 0) + " lx");
const fmtNit = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1000 ? (v / 1000).toFixed(1) + "k" : v.toFixed(0)) + " cd/m²";

// ------------------------------------------------------------------ state
let P = defaultParams();
let side = "A";
let selStop = 0;
// default camera: 24 mm on full frame (36 mm) = 73.74° HFOV, 16:9, pitch 20°, yaw 45°
const S = { view: "aces_sdr", viewEV: 0, dither: true,
  cam: { hfov: (2 * Math.atan(18 / 24) * 180) / Math.PI, aspect: 16 / 9, pitch: 20, yaw: 45 },
  sunRad: 0, sunOmega: 1, camScale: 1, YdA: 0.4, YgRef: 0.1, LAnchor: 1, LGround: 0.2, camEV: 0, ev100: 10,
  dirty: true, lutReady: false };
function syncLightUI() {
  const prg = usePrg();
  for (const k of ["light.skyLux", "light.sunLux"]) {
    const el = document.querySelector(`.slider[data-key="${k}"]`);
    if (!el) continue;
    el._sync && el._sync();
    el.querySelectorAll("input").forEach((i) => (i.disabled = prg || !!P.light.auto));
  }
  // PRG: visibility drives everything; CIE: sky type, extinction and the lux sliders
  $$(".prgOnly").forEach((e) => (e.style.display = prg ? "" : "none"));
  $$(".cieOnly").forEach((e) => (e.style.display = prg ? "none" : ""));
  $$(".clearOnly").forEach((e) => (e.style.display = P.light.condition === "clear" ? "" : "none"));
  // the designed sun colour is unused while the physical one is on
  const sc = document.querySelector('input[type=color][data-key="sun.color"]');
  if (sc) { const phys = prg && P.sun.physColor; sc.disabled = phys || !P.sun.disc; sc.title = phys ? "Physical sun colour (PRG) is on" : ""; }
  // sun off: the disc, sunlight and sun-glow controls have nothing to act on
  $$(".sunDep").forEach((e) => {
    e.classList.toggle("off", !P.sun.disc);
    e.querySelectorAll("input:not([type=color]), select").forEach((i) => (i.disabled = !P.sun.disc));
  });
  const oh = $("#sunOffHint");
  if (oh) oh.textContent = P.sun.disc ? "" : "pure gradient sky — no disc, sunlight or glow";
}
const getPath = (o, k) => k.split(".").reduce((a, b) => a[b], o);
function setPath(o, k, v) { const ks = k.split("."); const last = ks.pop(); ks.reduce((a, b) => a[b], o)[last] = v; }

function log(msg, cls) {
  const el = $("#log");
  const t = new Date().toLocaleTimeString();
  el.textContent = `[${t}] ${msg}\n` + el.textContent;
  if (cls === "err") console.error(msg);
}

// ------------------------------------------------------------------ WebGL
const glc = document.createElement("canvas");
const gl = glc.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false });
if (!gl) alert("WebGL2 is required.");
const floatOK = !!gl.getExtension("EXT_color_buffer_float");

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler3D;
out vec4 outColor;
#define MAXS ${MAX_STOPS}
uniform highp sampler2D uCurve; uniform float uCurveN;   // row 0 sun side, row 1 away side (OkLab, √elevation axis)
uniform float uSideBlend, uHorizonOffset, uHorizonSoft;
uniform vec3 uGndTop, uGndBot; uniform float uGndFalloff;
uniform vec3 uGlowColor; uniform float uGlowStrength, uGlowWidth, uBand, uBandHeight;
uniform float uSunAz; uniform vec3 uSunDir; uniform int uSunOn; uniform vec3 uSunRad; uniform float uSunR, uSunSoft;
uniform float uExposure, uSat, uGrain, uDispMax;
uniform highp sampler3D uInv, uFwd; uniform float uLutN, uCctMax;
uniform int uMode;      // 0 equirect, 1 camera, 2 profile
uniform int uOutput;    // 0 display preview, 1 ACEScg linear
uniform int uFlip, uDither, uWithSun, uSunOnly;
uniform vec2 uRes; uniform float uY0;
uniform float uCamYaw, uCamPitch, uCamTanH, uCamTanV;
uniform float uViewEV;
uniform vec4 uCIE; uniform float uCIEe, uW;              // CIE sky (a,b,c,d,e), weight of stop lightness
uniform int uSkyModel;                                   // 0 CIE standard sky, 1 Prague (PRG) table
uniform highp sampler2D uPrg; uniform vec2 uPrgN;        // PRG luminance (cd/m2): x = azimuth from sun, y = elevation
uniform vec3 uAnchorDir; uniform float uYdA, uYgRef;    // anchor direction + design luminances
uniform float uLAnchor, uLGround, uPreviewGain;         // Redshift units (1.0 = 683 cd/m2)
uniform vec3 uProbe[2];
uniform int uPlate; uniform float uPlateScale;

const float PI = 3.14159265358979;
float s2l(float v){ return v <= 0.04045 ? v/12.92 : pow((v+0.055)/1.055, 2.4); }
float l2s(float v){ return v <= 0.0031308 ? 12.92*v : 1.055*pow(max(v,0.0), 1.0/2.4) - 0.055; }
vec3 s2l(vec3 c){ return vec3(s2l(c.r), s2l(c.g), s2l(c.b)); }
vec3 l2s(vec3 c){ return vec3(l2s(c.r), l2s(c.g), l2s(c.b)); }
vec3 oklab2lin(vec3 L){
  float l = L.x + 0.3963377774*L.y + 0.2158037573*L.z;
  float m = L.x - 0.1055613458*L.y - 0.0638541728*L.z;
  float s = L.x - 0.0894841775*L.y - 1.2914855480*L.z;
  l = l*l*l; m = m*m*m; s = s*s*s;
  return vec3( 4.0767416621*l - 3.3077115913*m + 0.2309699292*s,
              -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
              -0.0041960863*l - 0.7034186147*m + 1.7076147010*s);
}
float lin2cct(float x){ return x <= 0.0078125 ? 10.5402377416545*x + 0.0729055341958355 : (log2(max(x,1e-10)) + 9.72)/17.52; }
float cct2lin(float c){ return c <= 0.155251141552511 ? (c - 0.0729055341958355)/10.5402377416545 : exp2(c*17.52 - 9.72); }
vec3 lin2cct(vec3 c){ return vec3(lin2cct(c.r), lin2cct(c.g), lin2cct(c.b)); }
vec3 cct2lin(vec3 c){ return vec3(cct2lin(c.r), cct2lin(c.g), cct2lin(c.b)); }

// manual trilinear (full float precision — hardware filtering is only ~8-bit fractional on many GPUs)
vec3 lut3(highp sampler3D t, vec3 x, float lo, float hi){
  float N = uLutN;
  vec3 p = (clamp(x, lo, hi) - lo) / (hi - lo) * (N - 1.0);
  vec3 i0 = min(floor(p), vec3(N - 2.0));
  vec3 f = p - i0;
  ivec3 i = ivec3(i0);
  vec3 c000 = texelFetch(t, i, 0).rgb;
  vec3 c100 = texelFetch(t, i + ivec3(1,0,0), 0).rgb;
  vec3 c010 = texelFetch(t, i + ivec3(0,1,0), 0).rgb;
  vec3 c110 = texelFetch(t, i + ivec3(1,1,0), 0).rgb;
  vec3 c001 = texelFetch(t, i + ivec3(0,0,1), 0).rgb;
  vec3 c101 = texelFetch(t, i + ivec3(1,0,1), 0).rgb;
  vec3 c011 = texelFetch(t, i + ivec3(0,1,1), 0).rgb;
  vec3 c111 = texelFetch(t, i + ivec3(1,1,1), 0).rgb;
  vec3 c00 = mix(c000, c100, f.x), c10 = mix(c010, c110, f.x);
  vec3 c01 = mix(c001, c101, f.x), c11 = mix(c011, c111, f.x);
  return mix(mix(c00, c10, f.y), mix(c01, c11, f.y), f.z);
}
vec3 displayToACEScg(vec3 d){ return cct2lin(lut3(uInv, d, 0.0, 1.0)); }
vec3 ACEScgToDisplay(vec3 l){ return lut3(uFwd, lin2cct(l), 0.0, uCctMax); }

// pre-built, smoothed gradient curve (see buildCurve in JS); full-float linear lookup
vec3 evalSide(float es, int row){
  float s = sqrt(clamp(es / 90.0, 0.0, 1.0));
  float x = s * (uCurveN - 1.0);
  float i0 = min(floor(x), uCurveN - 2.0);
  float f = x - i0;
  vec3 a = texelFetch(uCurve, ivec2(int(i0), row), 0).rgb;
  vec3 b = texelFetch(uCurve, ivec2(int(i0) + 1, row), 0).rgb;
  return mix(a, b, f);
}
float smoother(float a, float b, float x){ float t = clamp((x - a) / (b - a), 0.0, 1.0); return t*t*t*(t*(t*6.0 - 15.0) + 10.0); }
float softplus(float x, float k){ return k * (max(x / k, 0.0) + log(1.0 + exp(-abs(x / k)))); }

float hash(vec2 p){ p = fract(p*vec2(443.8975, 397.2973)); p += dot(p, p.yx + 19.19); return fract(p.x*p.y); }

// Designed display colour for a world direction (designer frame: phi=0 → -Z, +phi → +X).
// Every term is C-infinity: no clamps, cusps or C1-only blends that the eye reads as bands.
vec3 skyDisplay(vec3 dir){
  float e = degrees(asin(clamp(dir.y, -1.0, 1.0)));
  float phi = atan(dir.x, -dir.z);
  float eh = e - uHorizonOffset;
  float cd = cos(phi - uSunAz);
  float w = pow(0.5 + 0.5*cd, uSideBlend);
  w = mix(w, 0.5, smoother(50.0, 90.0, eh));               // converge at zenith (no pinch)
  float es = softplus(eh, 0.25 * uHorizonSoft + 0.02);      // smooth "max(eh,0)"
  vec3 skyLab = mix(evalSide(es, 1), evalSide(es, 0), w);
  float ge = softplus(-eh, 0.25 * uHorizonSoft + 0.02);     // smooth depth below horizon
  vec3 gndLab = mix(uGndTop, uGndBot, 1.0 - exp(-ge / uGndFalloff));
  float k = smoother(-uHorizonSoft, uHorizonSoft, eh);
  vec3 lab = mix(gndLab, skyLab, k);
  lab.yz *= uSat;
  vec3 disp = l2s(clamp(oklab2lin(lab), 0.0, 1.0));
  // glow: screen blend in display space. Cauchy-shaped aureole (smooth at the sun, long natural tail)
  float gam = degrees(acos(clamp(dot(dir, uSunDir), -1.0, 1.0)));
  float q = gam / uGlowWidth;
  float g = uGlowStrength / (1.0 + q*q)
          + uBand * exp(-es / uBandHeight) * pow(0.5 + 0.5*cd, 2.0);
  g *= mix(0.35, 1.0, k);
  disp = 1.0 - (1.0 - disp) * (1.0 - clamp(uGlowColor * g, 0.0, 1.0));
  return min(disp, vec3(uDispMax));
}

// ---------- intensity (separate from colour) ----------
float lumAP1(vec3 c){ return dot(c, vec3(0.2722287, 0.6740818, 0.0536895)); }
vec3 designLin(vec3 dir){ return displayToACEScg(skyDisplay(dir)); }   // colour design in ACEScg (EV0 look)

// CIE S 011 / ISO 15469 general sky: relative luminance = f(chi) * phi(Z)
float cieL(vec3 dir){
  float e = degrees(asin(clamp(dir.y, -1.0, 1.0))) - uHorizonOffset;
  float es = softplus(e, 0.25 * uHorizonSoft + 0.02);
  float cosZ = sin(radians(max(es, 0.02)));
  float phiZ = 1.0 + uCIE.x * exp(uCIE.y / cosZ);
  float chi = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
  chi = sqrt(chi*chi + 0.0004) - 0.02;                        // round the circumsolar cusp (~1 deg)
  float f = 1.0 + uCIE.z * (exp(uCIE.w * chi) - exp(uCIE.w * PI * 0.5)) + uCIEe * cos(chi) * cos(chi);
  return max(f * phiZ, 1e-4);
}
// Prague sky model: absolute luminance from the server's table for the current sun / visibility / albedo.
// Grid: elevation e = 90·s², azimuth difference to the sun a = 180·t² (s, t uniform) — dense at the horizon and sun.
float prgL(vec3 dir){
  float e = degrees(asin(clamp(dir.y, -1.0, 1.0))) - uHorizonOffset;
  float es = softplus(e, 0.25 * uHorizonSoft + 0.02);
  float s = sqrt(clamp(es / 90.0, 0.0, 1.0));
  float da = abs(mod(atan(dir.x, -dir.z) - uSunAz + PI, 2.0 * PI) - PI);
  float t = sqrt(clamp(da / PI, 0.0, 1.0));
  float x = t * (uPrgN.x - 1.0), y = s * (uPrgN.y - 1.0);
  float x0 = min(floor(x), uPrgN.x - 2.0), y0 = min(floor(y), uPrgN.y - 2.0);
  float fx = x - x0, fy = y - y0;
  ivec2 i = ivec2(int(x0), int(y0));
  float a = texelFetch(uPrg, i, 0).r, b = texelFetch(uPrg, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uPrg, i + ivec2(0, 1), 0).r, d = texelFetch(uPrg, i + ivec2(1, 1), 0).r;
  return max(mix(mix(a, b, fx), mix(c, d, fx), fy), 1e-4);
}
float skyDist(vec3 dir){ return uSkyModel == 1 ? prgL(dir) : cieL(dir); }
// relative sky luminance (1.0 at the anchor = where the camera looks): physics, optionally bent by stop lightness
float skyRel(vec3 dir, float Yd){
  float cie = skyDist(dir) / skyDist(uAnchorDir);
  float st = Yd / uYdA;
  return pow(cie, 1.0 - uW) * pow(max(st, 1e-6), uW);
}

// ACEScg radiance in Redshift units (1.0 = 683 cd/m2). Colour from the design, luminance from physics.
vec3 sky(vec3 dir, bool withSun){
  if (uPlate == 1) return designLin(dir) * uPlateScale;      // backplate: the designed look, camera-only dome
  vec3 dl = designLin(dir);
  float Yd = max(lumAP1(dl), 1e-6);
  vec3 chroma = dl / Yd;
  float e = degrees(asin(clamp(dir.y, -1.0, 1.0)));
  float eh = e - uHorizonOffset;
  float k = smoother(-uHorizonSoft, uHorizonSoft, eh);
  float Ysky = uLAnchor * skyRel(dir, Yd);
  float Ygnd = uLGround * Yd / uYgRef;                        // Lambertian ground, design keeps its falloff
  vec3 lin = chroma * mix(Ygnd, Ysky, k);
  float gam = degrees(acos(clamp(dot(dir, uSunDir), -1.0, 1.0)));
  if (uSunOnly == 1) lin = vec3(0.0);
  if (withSun && uSunOn == 1){
    float r0 = uSunR * (1.0 - uSunSoft);
    float prof = 1.0 - smoothstep(r0, uSunR + 1e-4, gam);
    prof *= smoothstep(-0.05, 0.05, eh);                      // hidden below the horizon
    lin += uSunRad * prof;
  }
  return lin;
}

void main(){
  vec2 fc = gl_FragCoord.xy - 0.5;
  float row = uFlip == 1 ? (uRes.y - 1.0 - fc.y) : (uY0 + fc.y);
  vec2 uv = vec2((fc.x + 0.5) / uRes.x, (row + 0.5) / uRes.y);
  vec3 dir;
  bool sun = uWithSun == 1;
  if (uMode == 0){
    float phi = (uv.x - 0.5) * 2.0 * PI;
    float el = (0.5 - uv.y) * PI;
    dir = vec3(sin(phi)*cos(el), sin(el), -cos(phi)*cos(el));
  } else if (uMode == 1){
    float x = (uv.x * 2.0 - 1.0) * uCamTanH, y = (1.0 - uv.y * 2.0) * uCamTanV;
    vec3 f = vec3(sin(uCamYaw)*cos(uCamPitch), sin(uCamPitch), -cos(uCamYaw)*cos(uCamPitch));
    vec3 r = vec3(cos(uCamYaw), 0.0, sin(uCamYaw));
    vec3 u = cross(r, f);
    dir = normalize(f + x*r + y*u);
  } else {
    // profile: x → elevation on a sqrt-warped axis (-10..90), row 0 sun side, row 1 away side
    float s0 = -sqrt(10.0/90.0);
    float s = mix(s0, 1.0, uv.x);
    float el = radians(sign(s) * s * s * 90.0);
    float phi = uSunAz + (row < 0.5 ? 0.0 : PI);
    dir = vec3(sin(phi)*cos(el), sin(el), -cos(phi)*cos(el));
  }
  if (uMode == 3) dir = uProbe[int(fc.x) < 1 ? 0 : 1];
  if (uOutput == 2){ outColor = vec4(skyDisplay(dir), 1.0); return; }   // exact designed display values
  if (uOutput == 3){ vec3 dl = designLin(dir); outColor = vec4(skyRel(dir, max(lumAP1(dl), 1e-6)), 0.0, 0.0, 1.0); return; }
  if (uOutput == 4){ outColor = vec4(lumAP1(designLin(dir)), 0.0, 0.0, 1.0); return; }
  vec3 lin = sky(dir, sun);
  if (uGrain > 0.0){
    float n = hash(vec2(fc.x, row) + 0.37) - hash(vec2(fc.x, row) + 11.71); // triangular
    lin *= 1.0 + uGrain * n;
  }
  if (uOutput == 1){ outColor = vec4(lin, 1.0); return; }
  vec3 d = ACEScgToDisplay(lin * uPreviewGain);   // gain = Redshift camera exposure (+ view EV)
  if (uDither == 1){
    float n = hash(fc + 3.1) - hash(fc + 7.7);
    d += n / 255.0;
  }
  outColor = vec4(d, 1.0);
}`;

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);
const vbo = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const ploc = gl.getAttribLocation(prog, "p");
gl.enableVertexAttribArray(ploc);
gl.vertexAttribPointer(ploc, 2, gl.FLOAT, false, 0, 0);
const U = {};
const uni = (n) => (n in U ? U[n] : (U[n] = gl.getUniformLocation(prog, n)));

let lutMeta = null;
const lutTex = {}, lutBuf = {};

// ---- CPU mirror of the shader's ACES view transforms (same LUTs, same manual trilinear), for the colour picker
const lin2cctJS = (x) => (x <= 0.0078125 ? 10.5402377416545 * x + 0.0729055341958355 : (Math.log2(Math.max(x, 1e-10)) + 9.72) / 17.52);
const cct2linJS = (c) => (c <= 0.155251141552511 ? (c - 0.0729055341958355) / 10.5402377416545 : Math.pow(2, c * 17.52 - 9.72));
function lut3JS(buf, x, lo, hi) {
  const N = lutMeta.size, out = [0, 0, 0];
  const p = x.map((v) => ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (N - 1));
  const i = p.map((v) => Math.min(Math.floor(v), N - 2)), f = p.map((v, k) => v - i[k]);
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
    const o = (((i[2] + dz) * N + (i[1] + dy)) * N + (i[0] + dx)) * 3;   // texel x = R (fastest), y = G, z = B
    out[0] += w * buf[o]; out[1] += w * buf[o + 1]; out[2] += w * buf[o + 2];
  }
  return out;
}
const DISP_MAX = 0.985;   // same clamp as the shader (uDispMax)
// display colour (as seen through Redshift's ACES 1.0 SDR view) → ACEScg at EV 0 — exactly what a stop becomes
function displayToACEScgJS(d) {
  const L = lutBuf.aces_sdr; if (!L) return null;
  return lut3JS(L.inv, d.map((v) => Math.min(v, DISP_MAX)), 0, 1).map(cct2linJS);
}
function ACEScgToDisplayJS(lin) {
  const L = lutBuf.aces_sdr; if (!L) return null;
  return lut3JS(L.fwd, lin.map(lin2cctJS), 0, lutMeta.cct_max);
}
// what the ACES view really shows for a requested display colour (≠ request when it can't be reached)
function acesReach(d) {
  const lin = displayToACEScgJS(d); if (!lin) return null;
  const back = ACEScgToDisplayJS(lin);
  const err = Math.max(...back.map((v, k) => Math.abs(v - d[k])));
  return { lin, back, ok: err <= 2.5 / 255, err };
}
window.acesPicker = { toACEScg: displayToACEScgJS, toDisplay: ACEScgToDisplayJS, reach: acesReach };
async function loadLuts(view) {
  if (!lutMeta) lutMeta = await (await fetch("/static/luts/luts.json")).json();
  if (!lutTex[view]) {
    const N = lutMeta.size;
    const mk = async (suffix) => {
      const buf = new Float32Array(await (await fetch(`/static/luts/${view}_${suffix}.bin`)).arrayBuffer());
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_3D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, N, N, N, 0, gl.RGB, gl.FLOAT, buf);
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
      return { t, buf };
    };
    const inv = await mk("inv"), fwd = await mk("fwd");
    lutTex[view] = { inv: inv.t, fwd: fwd.t };
    lutBuf[view] = { inv: inv.buf, fwd: fwd.buf };   // CPU copies for the colour picker
  }
  // the EXR is always defined by the ACES SDR inverse (Redshift's default view);
  // the chosen view only changes the preview's forward transform.
  if (!lutTex.aces_sdr) await loadLuts("aces_sdr");
  S.lutReady = true;
  S.dirty = true;
}

function bindLuts() {
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, lutTex.aces_sdr.inv);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex[S.view].fwd);
  gl.uniform1i(uni("uInv"), 0); gl.uniform1i(uni("uFwd"), 1);
  gl.uniform1f(uni("uLutN"), lutMeta.size);
  gl.uniform1f(uni("uCctMax"), lutMeta.cct_max);
}

function sortedStops(list) { return [...list].sort((a, b) => a.e - b.e); }

// ---- real-sky curvature: optical air mass (Kasten & Young 1989), e in degrees
const airmass = (e) => 1 / (Math.sin((Math.max(0, e) * Math.PI) / 180) + 0.50572 * Math.pow(Math.max(0, e) + 6.07995, -1.6364));
const M0 = airmass(0);
// "sky coordinate" τ: 0 at the horizon, 1 at the zenith, shaped like the Perez gradation term exp(-k·m).
// Small spread → colour change hugs the horizon; large spread → the transition climbs higher.
function tau(e, k) {
  const a = Math.exp(-k * (airmass(e) - 1)), a0 = Math.exp(-k * (M0 - 1));
  return (a - a0) / (1 - a0);
}

// Build one side's gradient as a dense OkLab curve on the √elevation axis:
//   1) stops placed in τ (air-mass) space → monotone cubic there (no overshoot, real-sky curvature)
//   2) Gaussian "flow" smoothing on the √elevation axis → C∞, no curvature jumps at stops (no Mach bands)
const CURVE_N = 2048;
function buildCurve(list) {
  const st = sortedStops(list).slice(0, MAX_STOPS);
  const k = Math.max(0.02, P.curve.spread);
  const ts = st.map((s) => tau(s.e, k));
  for (let i = 1; i < ts.length; i++) if (ts[i] <= ts[i - 1]) ts[i] = ts[i - 1] + 1e-6;
  const labs = st.map((s) => hexToLab(s.c));
  const ms = [0, 1, 2].map((ch) => monoTangents(ts, labs.map((l) => l[ch]), false));
  const raw = new Float32Array(CURVE_N * 3);
  for (let j = 0; j < CURVE_N; j++) {
    const s = j / (CURVE_N - 1), x = tau(90 * s * s, k);
    let i = 0;
    while (i < ts.length - 2 && x > ts[i + 1]) i++;
    for (let ch = 0; ch < 3; ch++) {
      let v;
      if (ts.length === 1 || x <= ts[0]) v = labs[0][ch];
      else if (x >= ts[ts.length - 1]) v = labs[ts.length - 1][ch];
      else {
        const h = ts[i + 1] - ts[i], t = (x - ts[i]) / h, t2 = t * t, t3 = t2 * t;
        v = (2 * t3 - 3 * t2 + 1) * labs[i][ch] + (t3 - 2 * t2 + t) * h * ms[ch][i] +
            (-2 * t3 + 3 * t2) * labs[i + 1][ch] + (t3 - t2) * h * ms[ch][i + 1];
      }
      raw[j * 3 + ch] = v;
    }
  }
  // Gaussian smoothing with even reflection at both ends (horizon: smooth in e; zenith: symmetric)
  const sig = P.curve.flow * (CURVE_N - 1);
  const out = new Float32Array(CURVE_N * 4);
  if (sig < 0.5) {
    for (let j = 0; j < CURVE_N; j++) for (let ch = 0; ch < 3; ch++) out[j * 4 + ch] = raw[j * 3 + ch];
    return out;
  }
  const R = Math.ceil(3 * sig), ker = new Float32Array(2 * R + 1);
  let ksum = 0;
  for (let i = -R; i <= R; i++) { ker[i + R] = Math.exp(-0.5 * (i / sig) ** 2); ksum += ker[i + R]; }
  // Edges: at the zenith an even mirror (the sky continues symmetrically over the top); at the horizon a POINT
  // reflection about the 0° value (f(-x) = 2·f(0) − f(x)), so smoothing keeps the horizon stop's colour exactly
  // instead of averaging it with the brighter colours above it.
  const top = (j) => (j < CURVE_N ? j : 2 * (CURVE_N - 1) - j);
  for (let j = 0; j < CURVE_N; j++) {
    let a = 0, b = 0, c = 0;
    for (let i = -R; i <= R; i++) {
      const jj = j + i, wgt = ker[i + R];
      if (jj < 0) {
        const q = Math.min(CURVE_N - 1, -jj) * 3;
        a += (2 * raw[0] - raw[q]) * wgt; b += (2 * raw[1] - raw[q + 1]) * wgt; c += (2 * raw[2] - raw[q + 2]) * wgt;
      } else {
        const q = top(jj) * 3;
        a += raw[q] * wgt; b += raw[q + 1] * wgt; c += raw[q + 2] * wgt;
      }
    }
    out[j * 4] = a / ksum; out[j * 4 + 1] = b / ksum; out[j * 4 + 2] = c / ksum;
  }
  return out;
}

const curveTex = gl.createTexture();
let curveKey = "";
function uploadCurves() {
  const key = JSON.stringify([P.A, P.B, P.link, P.curve]);
  if (key !== curveKey) {
    curveKey = key;
    const a = buildCurve(P.A), b = buildCurve(P.link ? P.A : P.B);
    S.curves = { A: a, B: b };                     // CPU copy: the editor tracks show exactly this curve
    const data = new Float32Array(CURVE_N * 8);
    data.set(a, 0); data.set(b, CURVE_N * 4);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, CURVE_N, 2, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, curveTex);
  gl.uniform1i(uni("uCurve"), 2);
  gl.uniform1f(uni("uCurveN"), CURVE_N);
}

// ------------------------------------------------------------------ Prague sky model (PRG Clear Sky)
// The server evaluates the model (tools/prg dataset) for the exact sun elevation, visibility and ground albedo and
// returns absolute sky luminance on an elevation × azimuth-from-sun grid, plus sun and sky illuminance.
// Until the first table arrives (or if the dataset is missing) the CIE / IES model is used.
const prgTex = gl.createTexture();
gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, prgTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 2, 2, 0, gl.RED, gl.FLOAT, new Float32Array(4).fill(1));
for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
S.prg = null; S.prgAvailable = null; S.prgPending = null;
const usePrg = () => P.light.condition === "clear" && P.light.model === "prg" && S.prgAvailable !== false;
const physSunColor = () => usePrg() && P.sun.physColor && S.prg && Array.isArray(S.prg.sunRGB);
const sunColorAP1 = () => (physSunColor() ? S.prg.sunRGB.slice() : mul3(M709_AP1, hexToRgb(P.sun.color).map(srgbDecode)));
// AP1 → linear Rec.709 (inverse of M709_AP1), for showing the physical sun colour as a swatch
const M_AP1_709 = (() => {
  const m = M709_AP1, d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  return [[(m[1][1] * m[2][2] - m[1][2] * m[2][1]) / d, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) / d, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) / d],
          [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) / d, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) / d, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) / d],
          [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) / d, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) / d, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) / d]];
})();
const sunSwatchHex = () => { const l = mul3(M_AP1_709, sunColorAP1()).map((v) => Math.max(0, v)); const mx = Math.max(...l, 1e-9); return rgbToHex(l.map((v) => srgbEncode(v / mx))); };
const prgKey = () => [P.sun.el.toFixed(2), (+P.light.visibility).toFixed(1), (+P.light.albedo).toFixed(3)].join("|");
function requestPrg() {
  const key = prgKey();
  if ((S.prg && S.prg.key === key) || S.prgPending === key) return;
  S.prgPending = key;
  const [el, vis, alb] = key.split("|");
  fetch(`/api/prg?el=${el}&vis=${vis}&alb=${alb}`).then((r) => r.json()).then((t) => {
    if (S.prgPending === key) S.prgPending = null;
    if (!t.ok) {
      if (t.available === false && S.prgAvailable !== false) { S.prgAvailable = false; log("PRG sky model unavailable (" + t.error + ") — using CIE / IES.", "err"); touch(); }
      return;
    }
    S.prgAvailable = true;
    const lum = new Float32Array(t.lum);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, prgTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, t.nAz, t.nEl, 0, gl.RED, gl.FLOAT, lum);   // rows = elevation
    S.prg = { key, nAz: t.nAz, nEl: t.nEl, lum, sunLux: t.sunLux, skyLux: t.skyLux, range: t.range,
              sunRGB: t.sunRGB, sunCCT: t.sunCCT };
    touch();
  }).catch((e) => { if (S.prgPending === key) S.prgPending = null; log("PRG request failed: " + e.message, "err"); });
}

const dirOf = (azDeg, elDeg) => {
  const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
};
const sunDir = () => dirOf(P.sun.az, P.sun.el);
// where the plate brightness is matched to the design: camera azimuth, a little above the horizon
const anchorDir = () => dirOf(S.cam.yaw, P.horizon.offset + P.light.anchorEl);
const groundRefDir = () => dirOf(S.cam.yaw, P.horizon.offset - P.horizon.softness - 1);

function setCommonUniforms() {
  bindLuts();
  uploadCurves();
  gl.uniform1f(uni("uSideBlend"), P.sideBlend);
  gl.uniform1f(uni("uHorizonOffset"), P.horizon.offset);
  gl.uniform1f(uni("uHorizonSoft"), Math.max(0.02, P.horizon.softness));
  gl.uniform3fv(uni("uGndTop"), hexToLab(P.ground.top));
  gl.uniform3fv(uni("uGndBot"), hexToLab(P.ground.bottom));
  gl.uniform1f(uni("uGndFalloff"), Math.max(0.5, P.ground.falloff));
  gl.uniform3fv(uni("uGlowColor"), hexToRgb(P.glow.color));
  gl.uniform1f(uni("uGlowStrength"), P.sun.disc ? P.glow.strength : 0);   // sun off = no sun glow either
  gl.uniform1f(uni("uGlowWidth"), Math.max(0.5, P.glow.width));
  gl.uniform1f(uni("uBand"), P.glow.band);
  gl.uniform1f(uni("uBandHeight"), Math.max(0.25, P.glow.bandHeight));
  gl.uniform1f(uni("uSunAz"), (P.sun.az * Math.PI) / 180);
  gl.uniform3fv(uni("uSunDir"), sunDir());
  gl.uniform1i(uni("uSunOn"), P.sun.disc && S.sunRad > 0 ? 1 : 0);
  gl.uniform1f(uni("uSunR"), P.sun.size / 2);
  gl.uniform1f(uni("uSunSoft"), P.sun.softness);
  // sun colour (ACEScg, normalised to unit luminance — colour only) × radiance: physical from the PRG spectrum,
  // or the designed colour (display hex → linear 709 → AP1)
  const sc = sunColorAP1();
  const Y = sc[0] * AP1_Y[0] + sc[1] * AP1_Y[1] + sc[2] * AP1_Y[2] || 1;
  gl.uniform3fv(uni("uSunRad"), sc.map((v) => (v / Y) * S.sunRad));
  // intensity model
  const prgOn = usePrg() && S.prg;
  gl.uniform1i(uni("uSkyModel"), prgOn ? 1 : 0);
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, prgTex);
  gl.uniform1i(uni("uPrg"), 3);
  gl.uniform2f(uni("uPrgN"), S.prg ? S.prg.nAz : 2, S.prg ? S.prg.nEl : 2);
  const cie = CIE_SKIES[+P.light.cie] || CIE_SKIES[12];
  gl.uniform4f(uni("uCIE"), cie[0], cie[1], cie[2], cie[3]);
  gl.uniform1f(uni("uCIEe"), cie[4]);
  gl.uniform1f(uni("uW"), P.light.stopsLightness);
  gl.uniform3fv(uni("uAnchorDir"), anchorDir());
  gl.uniform1f(uni("uYdA"), S.YdA);
  gl.uniform1f(uni("uYgRef"), S.YgRef);
  gl.uniform1f(uni("uLAnchor"), S.LAnchor);
  gl.uniform1f(uni("uLGround"), S.LGround);
  gl.uniform1f(uni("uPreviewGain"), Math.pow(2, S.camEV + S.viewEV));
  gl.uniform1f(uni("uSat"), P.saturation);
  gl.uniform1f(uni("uDispMax"), 0.985);
  gl.uniform1f(uni("uViewEV"), S.viewEV);
  const c = S.cam;
  gl.uniform1f(uni("uCamYaw"), (c.yaw * Math.PI) / 180);
  gl.uniform1f(uni("uCamPitch"), (c.pitch * Math.PI) / 180);
  const tanH = Math.tan((c.hfov * Math.PI) / 360);
  gl.uniform1f(uni("uCamTanH"), tanH);
  gl.uniform1f(uni("uCamTanV"), tanH / c.aspect);
}

function draw(mode, output, w, h, opts = {}) {
  gl.uniform1i(uni("uMode"), mode);
  gl.uniform1i(uni("uOutput"), output);
  gl.uniform1i(uni("uFlip"), opts.flip ? 1 : 0);
  gl.uniform1i(uni("uDither"), opts.dither ? 1 : 0);
  gl.uniform1i(uni("uWithSun"), opts.noSun ? 0 : 1);
  gl.uniform1i(uni("uSunOnly"), opts.sunOnly ? 1 : 0);
  gl.uniform1i(uni("uPlate"), 0);
  gl.uniform1f(uni("uPreviewGain"), Math.pow(2, S.camEV + S.viewEV) * (opts.gainMul || 1));
  gl.uniform1f(uni("uGrain"), opts.grain || 0);
  gl.uniform2f(uni("uRes"), opts.resW || w, opts.resH || h);
  gl.uniform1f(uni("uY0"), opts.y0 || 0);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// float framebuffer for readbacks / export
function makeFBO(w, h) {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE5);           // keep units 0-2 (LUTs, curves) untouched
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) throw new Error("Float framebuffer not supported");
  return { fb, tex, w, h, free() { gl.deleteFramebuffer(fb); gl.deleteTexture(tex); } };
}
function readFloat(mode, output, w, h, opts = {}) {
  const f = makeFBO(w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
  draw(mode, output, w, h, opts);
  const px = new Float32Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  f.free();
  return px;
}

// ------------------------------------------------------------------ sun calibration
// Sun radiance is set so that (sun illuminance ⟂ sun) = ratio × (sky illuminance on a horizontal plane).
function sunSolidAngle() {
  const R = (P.sun.size / 2) * (Math.PI / 180), r0 = R * (1 - P.sun.softness);
  let om = 0; const n = 400;
  for (let i = 0; i < n; i++) {
    const g = ((i + 0.5) / n) * R * 1.001;
    let prof = 1;
    if (g > r0) { const t = Math.min(1, (g - r0) / Math.max(1e-6, R - r0)); prof = 1 - t * t * (3 - 2 * t); }
    om += prof * 2 * Math.PI * Math.sin(g) * ((R * 1.001) / n);
  }
  return om;
}
// Exact solid angle of the sun disc as rasterised in an equirect of width W (so the exported
// sun delivers precisely the requested illuminance, independent of resolution).
function sunSolidAngleRaster(W) {
  const H = W / 2, R = P.sun.size / 2, r0 = R * (1 - P.sun.softness);
  const sd = sunDir(), deg = 180 / Math.PI;
  const yc = Math.round((0.5 - P.sun.el / 180) * H), span = Math.ceil(((R + 0.5) / 180) * H) + 2;
  let om = 0;
  for (let y = Math.max(0, yc - span); y <= Math.min(H - 1, yc + span); y++) {
    const el = (0.5 - (y + 0.5) / H) * Math.PI;
    const dOm = Math.cos(el) * (Math.PI / H) * ((2 * Math.PI) / W);
    for (let x = 0; x < W; x++) {
      const phi = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      const d = [Math.sin(phi) * Math.cos(el), Math.sin(el), -Math.cos(phi) * Math.cos(el)];
      const gam = Math.acos(Math.min(1, d[0] * sd[0] + d[1] * sd[1] + d[2] * sd[2])) * deg;
      if (gam > R + 1e-4) continue;
      let prof = 1;
      if (gam > r0) { const t = Math.min(1, (gam - r0) / Math.max(1e-6, R + 1e-4 - r0)); prof = 1 - t * t * (3 - 2 * t); }
      const eh = (el * deg) - P.horizon.offset;
      const t2 = Math.min(1, Math.max(0, (eh + 0.05) / 0.1)); prof *= t2 * t2 * (3 - 2 * t2);
      om += prof * dOm;
    }
  }
  return om;
}

function calibrate(exportW) {
  const L = P.light;
  // 1) real-world illuminance targets
  if (usePrg()) {
    // Prague sky model: illuminance follows from the model itself (sun elevation, visibility, albedo)
    requestPrg();
    if (S.prg) { L.skyLux = Math.round(S.prg.skyLux); L.sunLux = Math.round(S.prg.sunLux); }
    else { const d = daylight("clear", P.sun.el, L.extinction); L.skyLux = Math.round(d.sky); L.sunLux = Math.round(d.sun); }
  } else if (L.auto) {
    const d = daylight(L.condition, P.sun.el, L.extinction);
    L.skyLux = Math.round(d.sky); L.sunLux = Math.round(d.sun);
  }
  const sunOn = P.sun.disc && L.sunLux > 0 && P.sun.el > -P.sun.size;
  S.sunRad = 1; // placeholder so uniforms are valid for the probe passes
  setCommonUniforms();
  // 2) design luminance at the anchor (where the camera looks) and at the ground reference
  const a = anchorDir(), g = groundRefDir();
  gl.uniform3fv(uni("uProbe"), [...a, ...g]);
  const pr = readFloat(3, 4, 2, 1, { resW: 2, resH: 1 });
  S.YdA = Math.max(1e-6, pr[0]); S.YgRef = Math.max(1e-6, pr[4]);
  gl.uniform1f(uni("uYdA"), S.YdA);
  // 3) integrate the relative sky luminance against cos(zenith) → anchor luminance for the lux target
  const W = 512, H = 256;
  const px = readFloat(0, 3, W, H, { resW: W, resH: H });
  let I = 0, zen = 0;
  for (let y = 0; y < H / 2; y++) {
    const el = (0.5 - (y + 0.5) / H) * Math.PI;
    const dOm = Math.cos(el) * (Math.PI / H) * ((2 * Math.PI) / W);
    for (let x = 0; x < W; x++) { const v = px[(y * W + x) * 4]; I += v * Math.sin(el) * dOm; if (y === 0) zen += v / W; }
  }
  S.LAnchor = L.skyLux / (RS_NITS * Math.max(1e-9, I));                       // Redshift units
  S.LGround = (L.albedo * (L.skyLux + (sunOn ? L.sunLux * Math.max(0, Math.sin((P.sun.el * Math.PI) / 180)) : 0))) / (Math.PI * RS_NITS);
  // 4) sun: radiance = E⊥ / Ω (Ω of the disc as rasterised at the export width)
  S.sunOmega = sunSolidAngleRaster(exportW || 4096);
  S.sunRad = sunOn && S.sunOmega > 0 ? L.sunLux / (S.sunOmega * RS_NITS) : 0;
  // 5) exposure — two independent parts:
  //   A) camera exposure (Redshift camera EV): a meter reading (+ compensation), or a manual EV100
  //   B) background: the dome's Camera contribution (primary rays only — lighting, reflections and refractions
  //      always keep their physical values) = physical sky ± an offset in EV (0 = physical)
  S.camEV = 0;
  setCommonUniforms();
  const lin = readFloat(0, 1, W, H, { resW: W, resH: H, noSun: true });
  const f = dirOf(S.cam.yaw, S.cam.pitch), back = f.map((v) => -v);
  let Ecam = 0;
  for (let y = 0; y < H; y++) {
    const el = (0.5 - (y + 0.5) / H) * Math.PI;
    const dOm = Math.cos(el) * (Math.PI / H) * ((2 * Math.PI) / W);
    for (let x = 0; x < W; x++) {
      const phi = ((x + 0.5) / W - 0.5) * 2 * Math.PI;
      const c = Math.sin(phi) * Math.cos(el) * back[0] + Math.sin(el) * back[1] - Math.cos(phi) * Math.cos(el) * back[2];
      if (c <= 0) continue;
      const i = (y * W + x) * 4;
      Ecam += (lin[i] * AP1_Y[0] + lin[i + 1] * AP1_Y[1] + lin[i + 2] * AP1_Y[2]) * c * dOm;
    }
  }
  Ecam *= RS_NITS;
  if (sunOn) { const sd = sunDir(); Ecam += L.sunLux * Math.max(0, sd[0] * back[0] + sd[1] * back[1] + sd[2] * back[2]); }
  S.Ecam = Ecam;                                                   // incident light on a subject facing the camera
  const sunHor = sunOn ? L.sunLux * Math.max(0, Math.sin((P.sun.el * Math.PI) / 180)) : 0;
  S.Ehor = L.skyLux + sunHor;                                      // incident light on a horizontal surface
  // incident meter, 18 % grey card → mid grey:  EV100 = log2(0.18·E / (π·0.125))
  const evFromIncident = (E) => EV100_OFFSET - Math.log2((0.18 * Math.max(E, 1e-6)) / (Math.PI * 0.125));
  // EV at which the sky in the camera's direction renders exactly as designed (with Camera contribution 1)
  const evDesign = Math.log2(S.YdA / S.LAnchor);
  const X = P.exp;
  S.meterEV100 = EV100_OFFSET - evFromIncident(Ecam);               // what the meter reads right now
  // A) camera: the Redshift camera EV is a plain camera setting — it only changes when the user moves it or presses
  // Meter (and on preset load / Houdini sync when there's none yet), so light changes show their real brightness
  // (with PRG, wait until the sky table for the current light has arrived, so the reading uses the real sky)
  const lightReady = !usePrg() || (S.prg && S.prg.key === prgKey());
  S.meterEV = EV100_OFFSET - S.meterEV100;                         // the reading as a Redshift EV
  // unlocked: re-meter when anything in the parameters except the exposure itself changes (the camera lives outside
  // P, so moving it doesn't count)
  if (!X.lock && lightReady) {
    const { exp, ...rest } = P;
    const sig = JSON.stringify(rest);
    if (sig !== S.autoSig) { S.autoSig = sig; S.needMeter = true; }
  } else if (X.lock) S.autoSig = null;
  if (S.needMeter && lightReady) { X.ev = Math.round(S.meterEV * 20) / 20; S.needMeter = false; syncEV(); }
  S.camEV = X.ev;
  S.ev100 = EV100_OFFSET - S.camEV;
  // B) background, relative to the physical sky at this exposure
  S.bgPhysVsDesign = S.camEV - evDesign;                           // EV the physical sky sits above the design
  // the background offset is relative to the colour design: 0 = the sky in frame looks as designed at any exposure
  S.bgVsDesign = X.bgOffset;
  S.bgVsPhysical = X.bgOffset - S.bgPhysVsDesign;
  S.camScale = Math.pow(2, S.bgVsPhysical);
  setCommonUniforms();
  // readouts
  const sunH = sunHor;
  const tot = L.skyLux + sunH;
  const contrast = tot / L.skyLux;
  const shadow = !sunOn ? "no direct sun" : contrast < 1.3 ? "very soft shadows" : contrast < 2.5 ? "soft shadows" : contrast < 5 ? "defined shadows" : "hard sunlight";
  const modelLine = usePrg()
    ? (S.prg ? `<b>PRG Clear Sky</b> (Prague model) · visibility ${(+L.visibility).toFixed(0)} km · albedo ${L.albedo}` +
        (P.sun.el < -4.2 ? " · below −4.2° extrapolated" : "") : "PRG Clear Sky — loading… (CIE meanwhile)")
    : `CIE sky type ${L.cie}` + (L.auto ? " · IES daylight levels" : " · manual lux");
  $("#lightInfo").innerHTML = modelLine + "<br>" +
    `Sky <b>${fmtLux(L.skyLux)}</b> · sun ⟂ <b>${fmtLux(sunOn ? L.sunLux : 0)}</b> (horizontal ${fmtLux(sunH)})<br>` +
    `Total on ground ${fmtLux(tot)} · lit/shadow ${contrast.toFixed(1)}:1 — ${shadow}<br>` +
    `Sky at camera ${fmtNit(S.LAnchor * RS_NITS)} · zenith ${fmtNit(S.LAnchor * RS_NITS * zen)}` +
    (sunOn ? ` · sun disc ${fmtNit(S.sunRad * RS_NITS)}` : "");
  // exposure readouts (own section)
  const sgn = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d);
  const evDesc = (ev) => (ev >= 14 ? "bright daylight" : ev >= 12 ? "daylight" : ev >= 9 ? "low sun / sunset" : ev >= 5 ? "dusk / twilight" : "night");
  const dm = S.meterEV - S.camEV;
  $("#meterHint").textContent = !X.lock ? "auto — follows the meter (re-reads on light / design changes, not camera moves)"
    : Math.abs(dm) < 0.05 ? "matches the meter" : `meter reads ${sgn(S.meterEV, 2)} EV`;
  const evEl = document.querySelector('.slider[data-key="exp.ev"]');
  if (evEl) evEl.querySelectorAll("input").forEach((i) => (i.disabled = !X.lock));
  $("#meterBtn").disabled = !X.lock;
  $("#exposureInfo").innerHTML =
    `Camera ${sgn(S.camEV, 2)} EV = EV100 ${S.ev100.toFixed(1)} (${evDesc(S.ev100)})<br>` +
    `Background: Camera contribution ${S.camScale.toPrecision(3)} = ${sgn(S.bgVsPhysical)} EV vs the physical sky`;
  const colourNote = physSunColor() && P.sun.disc
    ? `<br>Colour: physical (PRG) <span class="swatch" style="background:${sunSwatchHex()}"></span>` +
      (S.prg.sunCCT && S.prg.sunCCT > 1900 ? ` ≈ ${Math.round(S.prg.sunCCT / 50) * 50} K` : " deep orange-red")
    : "";
  $("#sunInfo").innerHTML = (sunOn
    ? `Sun ${fmtLux(L.sunLux)} ⟂ · Ω ${(S.sunOmega * 1e5).toFixed(2)}e-5 sr · ${S.sunRad.toExponential(2)} RS units → 32-bit EXR`
    : !P.sun.disc ? "Sun off — pure gradient sky, no direct light"
    : P.sun.el <= 0 ? "Sun below the horizon — no direct light" : "No direct sun (overcast or illuminance 0)") + colourNote;
  syncLightUI();
}

// ------------------------------------------------------------------ rendering of views
const camCv = $("#camView"), eqCv = $("#eqView"), prCv = $("#profile");
// Fit a canvas into its box (keeping aspect, like object-fit: contain) and size its backing store.
function fitCanvas(cv, aspect) {
  const box = cv.parentElement;
  const bw = Math.max(32, box.clientWidth), bh = Math.max(16, box.clientHeight || bw / aspect);
  let cw = bw, ch = bw / aspect;
  if (ch > bh) { ch = bh; cw = bh * aspect; }
  cw = Math.floor(cw); ch = Math.floor(ch);
  if (cv.style.width !== cw + "px") cv.style.width = cw + "px";
  if (cv.style.height !== ch + "px") cv.style.height = ch + "px";
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(64, Math.round(cw * dpr)), h = Math.max(32, Math.round(w / aspect));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return [w, h];
}
function blit(cv, w, h) {
  if (glc.width !== w || glc.height !== h) { glc.width = w; glc.height = h; }
  return () => cv.getContext("2d").drawImage(glc, 0, 0);
}
function renderView(cv, mode, aspect) {
  const [w, h] = fitCanvas(cv, aspect);
  const done = blit(cv, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  // with a separate sun dome the camera never sees the disc, so neither does the preview
  // what the render's background shows: the dome × its Camera contribution, through the camera exposure
  draw(mode, 0, w, h, { flip: true, dither: S.dither, noSun: P.sun.mode === "separate", gainMul: S.camScale });
  done();
  return [w, h];
}

let profileData = null;
function renderProfile() {
  const W = 512, pm = $("#profMode").value;
  // design colours (for the stop track) and the final look through the Redshift camera exposure (plotted)
  const pxD = readFloat(2, 2, W, 2, { resW: W, resH: 2, y0: 0, noSun: true });
  // display through the view chosen for the profile (its forward LUT bound on unit 1 just for this read)
  const view = pm === "view" || pm === "lin" ? S.view : pm;
  const swap = view !== S.view && lutTex[view];
  if (swap) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex[view].fwd); }
  const px = readFloat(2, 0, W, 2, { resW: W, resH: 2, y0: 0, noSun: true, gainMul: S.camScale });
  if (swap) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, lutTex[S.view].fwd); }
  // the 32-bit float values written to the EXR (ACEScg, Redshift units — before camera exposure)
  const lin = pm === "lin" ? readFloat(2, 1, W, 2, { resW: W, resH: 2, y0: 0, noSun: true }) : null;
  profileData = { W, px: pxD };
  const [w, h] = fitCanvas(prCv, 2);
  const ctx = prCv.getContext("2d");
  ctx.fillStyle = "#151517"; ctx.fillRect(0, 0, w, h);
  const s0 = -Math.sqrt(10 / 90);
  const X = (e) => ((Math.sign(e) * Math.sqrt(Math.abs(e) / 90) - s0) / (1 - s0)) * w;
  // swatch strip
  const sh = Math.round(h * 0.09);
  for (let r = 0; r < 2; r++) for (let x = 0; x < W; x++) {
    const i = (r * W + x) * 4;
    ctx.fillStyle = rgbToHex([px[i], px[i + 1], px[i + 2]]);
    ctx.fillRect(Math.floor((x / W) * w), r * sh, Math.ceil(w / W) + 1, sh);
  }
  // grid
  const top = sh * 2 + 8, bot = h - 16;
  ctx.strokeStyle = "#2c2c30"; ctx.lineWidth = 1; ctx.font = `${Math.round(h * 0.035)}px system-ui`; ctx.fillStyle = "#77777d";
  for (const e of [-10, -3, 0, 1, 3, 5, 10, 20, 45, 90]) {
    const x = X(e); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.stroke();
    ctx.fillText(e + "°", Math.min(w - 22, x + 2), h - 4);
  }
  // y axis: display 0–1 (linear), or for the float data a log2 axis (one line per stop / EV)
  let Yp, curveSrc = px;
  if (lin) {
    curveSrc = lin;
    let mn = Infinity, mx = 0;
    for (let i = 0; i < W * 2 * 4; i += 4) for (let c = 0; c < 3; c++) { const v = lin[i + c]; if (v > 1e-7) { mn = Math.min(mn, v); mx = Math.max(mx, v); } }
    const hiE = Math.ceil(Math.log2(Math.max(mx, 1e-6))), loE = Math.max(hiE - 16, Math.floor(Math.log2(Math.max(mn, 1e-7))));
    const span = Math.max(1, hiE - loE);
    Yp = (v) => bot - ((Math.log2(Math.max(v, 2 ** loE)) - loE) / span) * (bot - top);
    const stepE = span > 10 ? 2 : 1;
    for (let e = loE; e <= hiE; e += stepE) {
      const y = Yp(2 ** e); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      const v = 2 ** e; ctx.fillText(v >= 1 ? String(+v.toFixed(v < 10 ? 1 : 0)) : String(+v.toPrecision(2)), 3, y - 2);
    }
  } else {
    Yp = (v) => bot - v * (bot - top);
    for (const v of [0.25, 0.5, 0.75, 1]) { ctx.beginPath(); ctx.moveTo(0, Yp(v)); ctx.lineTo(w, Yp(v)); ctx.stroke(); }
  }
  ctx.strokeStyle = "#555"; ctx.beginPath(); ctx.moveTo(X(0), top); ctx.lineTo(X(0), bot); ctx.stroke();
  // flow meter: |dL/dx| of OkLab lightness on this axis. A smooth hump = smooth gradient;
  // corners / sudden dips = places the eye would read as a band.
  const flowH = (bot - top) * 0.32;
  for (let r = 0; r < 2; r++) {
    const L = [];
    for (let x = 0; x < W; x++) { const i = (r * W + x) * 4; L.push(linToOklab([px[i], px[i + 1], px[i + 2]].map(srgbDecode))[0]); }
    const d = L.map((v, x) => (x === 0 ? L[1] - L[0] : x === W - 1 ? L[W - 1] - L[W - 2] : (L[x + 1] - L[x - 1]) / 2));
    const eStart = Math.max(0.3, 1.5 * P.horizon.softness + P.horizon.offset); // skip the horizon transition itself
    const s0x = Math.round(((Math.sqrt(eStart / 90) - s0) / (1 - s0)) * (W - 1));
    const mx = Math.max(1e-5, ...d.slice(s0x).map(Math.abs));
    ctx.strokeStyle = r ? "#9a9aa0" : "#e8e8ec"; ctx.lineWidth = 1.2 * (devicePixelRatio || 1);
    ctx.setLineDash(r ? [3, 3] : []);
    ctx.beginPath();
    for (let x = s0x; x < W; x++) {
      const xx = (x / (W - 1)) * w, yy = bot - (Math.abs(d[x]) / mx) * flowH;
      x === s0x ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = "#77777d"; ctx.fillText("flow |dL|", 4, bot - flowH - 3);
  // stop markers (active side)
  for (const st of curStops()) {
    const x = X(st.e); ctx.fillStyle = st.c; ctx.strokeStyle = "#000";
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x - 4, top - 6); ctx.lineTo(x + 4, top - 6); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  const cols = ["#e0675f", "#6fbf73", "#6c95e0"];
  for (let r = 0; r < 2; r++) {
    ctx.setLineDash(r ? [5, 4] : []);
    for (let ch = 0; ch < 3; ch++) {
      ctx.strokeStyle = cols[ch]; ctx.lineWidth = 1.5 * (devicePixelRatio || 1); ctx.beginPath();
      for (let x = 0; x < W; x++) {
        const v = curveSrc[(r * W + x) * 4 + ch];
        const xx = (x / (W - 1)) * w;
        x ? ctx.lineTo(xx, Yp(v)) : ctx.moveTo(xx, Yp(v));
      }
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
}

// camera frame outline on an equirect of size w × h: points along the border (a jump > w/2 = wrap-around break)
function camFrameOutline(w, h) {
  const ax = (az) => ((((az / 360 + 0.5) % 1) + 1) % 1) * w;
  const ey = (el) => (0.5 - el / 180) * h;
  const c = S.cam, tanH = Math.tan((c.hfov * Math.PI) / 360), tanV = tanH / c.aspect;
  const yaw = (c.yaw * Math.PI) / 180, pit = (c.pitch * Math.PI) / 180;
  const f = [Math.sin(yaw) * Math.cos(pit), Math.sin(pit), -Math.cos(yaw) * Math.cos(pit)];
  const r = [Math.cos(yaw), 0, Math.sin(yaw)];
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  const pts = [];
  const edge = (x, y) => {
    const d = [0, 1, 2].map((i) => f[i] + x * tanH * r[i] + y * tanV * u[i]);
    const L = Math.hypot(...d);
    const el = Math.asin(d[1] / L) * 180 / Math.PI, az = Math.atan2(d[0], -d[2]) * 180 / Math.PI;
    pts.push([ax(az), ey(el)]);
  };
  for (let i = 0; i <= 20; i++) edge(-1 + i / 10, 1);
  for (let i = 0; i <= 20; i++) edge(1, 1 - i / 10);
  for (let i = 0; i <= 20; i++) edge(1 - i / 10, -1);
  for (let i = 0; i <= 20; i++) edge(-1, -1 + i / 10);
  return pts;
}
const sunMarkerR = (w) => Math.max(5, w / 120);
function drawEqOverlay(w, h) {
  const ctx = eqCv.getContext("2d");
  const ax = (az) => ((((az / 360 + 0.5) % 1) + 1) % 1) * w;
  const ey = (el) => (0.5 - el / 180) * h;
  const lw = Math.max(1, w / 900);
  ctx.lineWidth = lw;
  // horizon
  ctx.strokeStyle = "#ffffff22"; ctx.beginPath(); ctx.moveTo(0, ey(P.horizon.offset)); ctx.lineTo(w, ey(P.horizon.offset)); ctx.stroke();
  // camera frame — its border is the drag handle (highlighted while hovered / dragged)
  const pts = camFrameOutline(w, h);
  ctx.strokeStyle = S.eqFrameHot ? "#ffffff" : "#ffffffaa"; ctx.lineWidth = S.eqFrameHot ? lw * 2.5 : lw;
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i && Math.abs(x - pts[i - 1][0]) < w / 2 ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.lineWidth = lw;
  // sun marker
  const sx = ax(P.sun.az), sy = ey(P.sun.el);
  ctx.strokeStyle = "#ffd27a"; ctx.beginPath(); ctx.arc(sx, sy, sunMarkerR(w), 0, Math.PI * 2); ctx.stroke();
}

function renderAll() {
  if (!S.lutReady) return;
  setCommonUniforms();
  calibrate();
  setCommonUniforms();
  renderView(camCv, 1, S.cam.aspect);
  const [w, h] = renderView(eqCv, 0, 2);
  drawEqOverlay(w, h);
  renderProfile();
  updateTrack();
  if (window.cpRefresh) window.cpRefresh();      // open colour picker follows the selected stop / undo
}
function loop() {
  if (S.dirty) { S.dirty = false; try { renderAll(); } catch (e) { log("Render error: " + e.message, "err"); } }
  requestAnimationFrame(loop);
}
const touch = () => { S.dirty = true; H.pending = true; histSchedule(); };

// ------------------------------------------------------------------ undo / redo
// Snapshots of all design parameters (P: gradients, light, sun, horizon, glow…). Drags, slider moves and
// colour-picker scrubbing are merged into one step each. Camera framing and exposure readings are not part of it.
const H = { stack: [], i: -1, last: "", pending: true, timer: 0, ptrDown: false, max: 300 };
// one step per finished edit: after the pointer is released and edits pause for a moment
function histSchedule() {
  clearTimeout(H.timer);
  H.timer = setTimeout(() => { if (H.pending && !H.ptrDown) histCommit(); }, 350);
}
function histCommit() {
  if (!S.lutReady) return;
  // render first so values derived from the edit (e.g. lux from sun elevation) belong to the same step
  if (S.dirty) { S.dirty = false; try { renderAll(); } catch (e) { log("Render error: " + e.message, "err"); } }
  H.pending = false;
  const s = JSON.stringify(P);
  if (s === H.last) return;
  H.stack.splice(H.i + 1);                       // a new edit drops the redo branch
  H.stack.push({ p: s, side, selStop });
  if (H.stack.length > H.max) H.stack.shift();
  H.i = H.stack.length - 1; H.last = s;
  updateHistBtns();
}
function histGo(d) {
  histCommit();                                  // flush an edit made just before the shortcut
  const j = H.i + d;
  if (j < 0 || j >= H.stack.length) return;
  H.i = j; const e = H.stack[j];
  P = JSON.parse(e.p); H.last = e.p; side = e.side; selStop = e.selStop;
  syncUI(); H.pending = false;
  updateHistBtns();
}
function updateHistBtns() {
  $("#btnUndo").disabled = H.i <= 0;
  $("#btnRedo").disabled = H.i >= H.stack.length - 1;
  $("#btnUndo").title = `Undo (Ctrl+Z) — ${H.i} step${H.i === 1 ? "" : "s"}`;
  $("#btnRedo").title = `Redo (Ctrl+Y / Ctrl+Shift+Z) — ${H.stack.length - 1 - H.i} step${H.stack.length - 1 - H.i === 1 ? "" : "s"}`;
}
// a new gesture closes the previous step first, so quick successive edits stay separate
window.addEventListener("pointerdown", () => { if (H.pending) histCommit(); H.ptrDown = true; }, true);
for (const t of ["pointerup", "pointercancel"]) window.addEventListener(t, () => { H.ptrDown = false; if (H.pending) histSchedule(); }, true);
$("#btnUndo").addEventListener("click", () => histGo(-1));
$("#btnRedo").addEventListener("click", () => histGo(1));
window.addEventListener("keydown", (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k !== "z" && k !== "y") return;
  // text / number fields keep their own typing undo
  const a = document.activeElement;
  if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && /^(text|number|search)$/.test(a.type)))) return;
  ev.preventDefault();
  histGo(k === "y" || ev.shiftKey ? 1 : -1);
});
window.addEventListener("resize", touch);
// boxes change size when the header wraps or panels reflow, not only on window resize
if (window.ResizeObserver) new ResizeObserver(touch).observe($("#views"));

// ------------------------------------------------------------------ gradient track editor (both sides)
const tracks = $$("#gradEditor .track");
const s2e = (s) => 90 * s * s;
const e2s = (e) => Math.sqrt(Math.max(0, e) / 90);
const stopsFor = (sd) => (sd === "A" || P.link ? P.A : P.B);
const curStops = () => stopsFor(side);
const trackOf = (sd) => tracks.find((t) => t.dataset.side === sd);
// display colour of a side's stop curve at track position s (0..1 on the √elevation axis), as the shader makes it
function curveHex(sd, s) {
  const c = S.curves[sd === "A" || P.link ? "A" : "B"], j = Math.round(Math.min(1, Math.max(0, s)) * (CURVE_N - 1)) * 4;
  return labToHex([c[j], c[j + 1] * P.saturation, c[j + 2] * P.saturation]);
}

function buildTicks() {
  const t = $("#trackTicks"); t.innerHTML = "";
  for (const e of [0, 1, 3, 5, 10, 20, 45, 90]) {
    const sp = document.createElement("span"); sp.textContent = e + "°"; sp.style.left = e2s(e) * 100 + "%"; t.appendChild(sp);
  }
}
function updateTrack() {
  const listSel = curStops();
  if (selStop >= listSel.length) selStop = listSel.length - 1;
  for (const t of tracks) {
    const sd = t.dataset.side;
    // background = this side's stop gradient itself (after Flow), exactly what the stops define — without the
    // horizon/ground blend and glow, which the camera, dome and profile views show
    if (S.curves) {
      const stopsCss = [];
      for (let k = 0; k <= 64; k++) {
        const s = k / 64;
        stopsCss.push(`${curveHex(sd, s)} ${(s * 100).toFixed(2)}%`);
      }
      t.querySelector(".trackGrad").style.background = `linear-gradient(90deg, ${stopsCss.join(",")})`;
    }
    t.classList.toggle("active", sd === side || P.link);
    t.classList.toggle("linked", P.link && sd === "B");
    t.title = P.link && sd === "B" ? "Linked to the sun side — untick Link sides to edit separately" : "Click the strip below the gradient (or double-click the gradient) to add a stop";
    t.querySelectorAll(".stop").forEach((n) => n.remove());
    const list = stopsFor(sd);
    list.forEach((st, i) => {
      const d = document.createElement("div");
      d.className = "stop" + (list === listSel && i === selStop ? " sel" : "");
      d.style.left = e2s(st.e) * 100 + "%";
      d.style.setProperty("--c", st.c);
      d.title = `${st.e.toFixed(1)}°  ${st.c}`;
      d.addEventListener("pointerdown", (ev) => startDrag(ev, sd, i));
      t.appendChild(d);
    });
  }
  const st = listSel[selStop];
  if (st) {
    $("#stopColor").value = st.c; $("#stopHex").value = st.c;
    if (document.activeElement !== $("#stopElev")) $("#stopElev").value = st.e.toFixed(st.e < 10 ? 2 : 1);
  }
  $("#selSideLbl").textContent = P.link ? "Both sides (linked)" : side === "A" ? "Sun side" : "Away side";
}
function startDrag(ev, sd, i) {
  ev.preventDefault(); ev.stopPropagation();
  side = sd; selStop = i; const st = stopsFor(sd)[i];
  const rect = trackOf(sd).getBoundingClientRect();
  const move = (e) => {
    const s = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    // 0.01° steps: the axis is stretched near the horizon, 0.1° steps made the low stops stick
    st.e = Math.round(s2e(s) * 100) / 100;
    const list = stopsFor(sd); list.sort((a, b) => a.e - b.e); selStop = list.indexOf(st);
    touch();
  };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  touch();
}
// add a stop on a side at a screen x; its colour = the gradient there, so adding doesn't change the look
function addStopAt(t, clientX) {
  side = t.dataset.side;
  const rect = t.getBoundingClientRect();
  const s = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const list = curStops();
  if (list.length >= MAX_STOPS) return log(`Max ${MAX_STOPS} stops per side.`);
  const st = { e: Math.round(s2e(s) * 100) / 100, c: S.curves ? curveHex(side, s) : "#999999" };
  list.push(st); list.sort((a, b) => a.e - b.e); selStop = list.indexOf(st);
  touch();
}
for (const t of tracks) {
  t.title = "Click the strip below the gradient (or double-click the gradient) to add a stop";
  // click on an empty part of a track selects that side
  t.addEventListener("pointerdown", () => { if (side !== t.dataset.side) { side = t.dataset.side; selStop = 0; touch(); } });
  // single click in the handle strip below the bar = add a stop (like most gradient editors)
  t.addEventListener("click", (ev) => {
    if (ev.target !== t) return;                              // bar itself or a stop: not the strip
    const bar = t.querySelector(".trackGrad").getBoundingClientRect();
    if (ev.clientY > bar.bottom) addStopAt(t, ev.clientX);
  });
  t.addEventListener("dblclick", (ev) => {
    side = t.dataset.side;
    // double-click on a stop = edit its colour (not add a new stop on top of it)
    if (ev.target.closest(".stop")) { updateTrack(); if (window.cpOpen) window.cpOpen($("#stopColor")); return; }
    if (ev.target === t) return;                              // strip: the single click already added one
    addStopAt(t, ev.clientX);
  });
}
// Delete / Backspace removes the selected stop (not while typing in a field)
window.addEventListener("keydown", (ev) => {
  if ((ev.key === "Delete" || ev.key === "Backspace") && $("#refModal").classList.contains("hidden") &&
      !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "")) {
    const list = curStops(); if (list.length <= 1) return;
    list.splice(selStop, 1); selStop = Math.max(0, selStop - 1); touch(); ev.preventDefault();
  }
});
$("#stopColor").addEventListener("input", (e) => { const st = curStops()[selStop]; if (st) { st.c = e.target.value; touch(); } });
$("#stopHex").addEventListener("change", (e) => {
  const v = e.target.value.trim(); const st = curStops()[selStop];
  if (st && /^#?[0-9a-fA-F]{6}$/.test(v)) { st.c = (v[0] === "#" ? v : "#" + v).toLowerCase(); touch(); }
});
$("#stopElev").addEventListener("change", (e) => {
  const st = curStops()[selStop]; if (!st) return;
  st.e = Math.min(90, Math.max(0, parseFloat(e.target.value) || 0)); curStops().sort((a, b) => a.e - b.e);
  selStop = curStops().indexOf(st); touch();
});
$("#stopDel").addEventListener("click", () => {
  const list = curStops(); if (list.length <= 1) return; list.splice(selStop, 1); selStop = Math.max(0, selStop - 1); touch();
});
$("#linkSides").addEventListener("change", (e) => { P.link = e.target.checked; touch(); });
$("#copyAB").addEventListener("click", () => { P.B = deepCopy(P.A); touch(); log("Copied sun-side stops to away side."); });
$("#copyBA").addEventListener("click", () => { P.A = deepCopy(P.B); touch(); log("Copied away-side stops to sun side."); });
$$("[data-nudge]").forEach((b) => b.addEventListener("click", () => {
  const k = b.dataset.nudge; const sgn = k.endsWith("+") ? 1 : -1;
  for (const st of curStops()) {
    const lab = hexToLab(st.c);
    if (k[0] === "L") lab[0] += 0.01 * sgn; else { lab[1] += 0.004 * sgn; lab[2] += 0.008 * sgn; }
    st.c = labToHex(lab);
  }
  touch();
}));

// ------------------------------------------------------------------ generic sliders / inputs
function buildSliders() {
  $$(".slider").forEach((el) => {
    const key = el.dataset.key, min = +el.dataset.min, max = +el.dataset.max, step = +el.dataset.step;
    const curve = +(el.dataset.curve || 1);
    el.innerHTML = `<span class="lbl">${el.dataset.label}</span><input type="range" min="0" max="1000"><input type="number" step="${step}">`;
    const rng = el.querySelector("input[type=range]"), num = el.querySelector("input[type=number]");
    const toR = (v) => Math.round(Math.pow((v - min) / (max - min), 1 / curve) * 1000);
    const fromR = (r) => min + Math.pow(r / 1000, curve) * (max - min);
    const snap = (v) => Math.round(v / step) * step;
    el._sync = () => { const v = getPath(P, key); rng.value = toR(Math.min(max, Math.max(min, v))); num.value = +v.toFixed(5); };
    rng.addEventListener("input", () => { const v = +snap(fromR(+rng.value)).toFixed(5); setPath(P, key, v); num.value = v; touch(); });
    num.addEventListener("change", () => { const v = parseFloat(num.value); if (!isNaN(v)) { setPath(P, key, v); el._sync(); touch(); } });
  });
  $$("input[type=color][data-key]").forEach((el) => {
    el._sync = () => (el.value = getPath(P, el.dataset.key));
    el.addEventListener("input", () => { setPath(P, el.dataset.key, el.value); touch(); });
  });
  const cieSel = $('select[data-key="light.cie"]');
  for (const [k, v] of Object.entries(CIE_SKIES)) { const o = document.createElement("option"); o.value = k; o.textContent = `${k} · ${v[5]}`; cieSel.appendChild(o); }
  $$("select[data-key]").forEach((el) => {
    el._sync = () => (el.value = getPath(P, el.dataset.key));
    el.addEventListener("change", () => { setPath(P, el.dataset.key, el.value); touch(); });
  });
  $$("input[type=checkbox][data-key]").forEach((el) => {
    el._sync = () => (el.checked = !!getPath(P, el.dataset.key));
    el.addEventListener("change", () => { setPath(P, el.dataset.key, el.checked); touch(); });
  });
}
// choosing a condition suggests the matching CIE standard sky
const CIE_FOR = { clear: "12", partly: "7", overcast: "1" };
document.querySelector('select[data-key="light.condition"]').addEventListener("change", (e) => {
  P.light.condition = e.target.value; P.light.cie = CIE_FOR[e.target.value]; syncUI();
});
// Meter: set the camera EV100 from the current reading (undoable like any other change)
$("#meterBtn").addEventListener("click", () => { S.needMeter = true; touch(); });
function syncEV() { const el = document.querySelector('.slider[data-key="exp.ev"]'); if (el && el._sync) el._sync(); }
function syncUI() {
  $$(".slider, input[data-key], select[data-key]").forEach((el) => el._sync && el._sync());
  $("#linkSides").checked = !!P.link;
  touch();
}

// header controls
$("#viewSel").addEventListener("change", async (e) => { S.view = e.target.value; await loadLuts(S.view); });
$("#profMode").addEventListener("change", async (e) => {
  const m = e.target.value;
  if (m === "aces_sdr" || m === "untonemapped") await loadLuts(m);          // LUT on demand (keeps S.view)
  $("#profHint").textContent = m === "lin"
    ? "values in the 32-bit float EXR (ACEScg, 1.0 = 683 cd/m², before camera exposure) — log scale, one line per stop"
    : "display RGB vs elevation (√ axis) — solid: sun side, dashed: away";
  touch();
});
$("#viewEV").addEventListener("input", (e) => { S.viewEV = parseFloat(e.target.value) || 0; touch(); });
$("#dither").addEventListener("change", (e) => { S.dither = e.target.checked; touch(); });
for (const [id, k] of [["#camHfov", "hfov"], ["#camAspect", "aspect"], ["#camPitch", "pitch"], ["#camYaw", "yaw"]]) {
  $(id).addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) { S.cam[k] = k === "hfov" ? clampFov(v) : k === "aspect" ? Math.min(4, Math.max(0.25, v)) : v; syncCamInputs(id); touch(); }
  });
}
// lens: focal length on a film back ↔ horizontal FOV
const filmW = () => parseFloat($("#camFilm").value) || 36;
const clampFov = (v) => Math.min(150, Math.max(1, v));
const focalOf = (hfov) => filmW() / 2 / Math.tan((hfov * Math.PI) / 360);
const hfovOf = (f) => (2 * Math.atan(filmW() / 2 / f) * 180) / Math.PI;
$("#camFocal").addEventListener("input", (e) => {
  const f = parseFloat(e.target.value); if (f > 0) { S.cam.hfov = clampFov(hfovOf(f)); syncCamInputs("#camFocal"); touch(); }
});
$("#camFilm").addEventListener("change", () => {   // keep the lens, change the sensor → FOV changes (like a real body swap)
  const f = parseFloat($("#camFocal").value); if (f > 0) S.cam.hfov = clampFov(hfovOf(f)); syncCamInputs(); touch();
});
$("#camAspectSel").addEventListener("change", (e) => { const v = parseFloat(e.target.value); if (v > 0) { S.cam.aspect = v; syncCamInputs(); touch(); } });
function syncCamInputs(skip) {
  const set = (id, v) => { if (id !== skip) $(id).value = v; };
  set("#camHfov", S.cam.hfov.toFixed(2)); set("#camAspect", S.cam.aspect.toFixed(3));
  set("#camPitch", S.cam.pitch.toFixed(2)); set("#camYaw", S.cam.yaw.toFixed(1));
  set("#camFocal", focalOf(S.cam.hfov).toFixed(1));
  const opt = [...$("#camAspectSel").options].find((o) => o.value && Math.abs(+o.value - S.cam.aspect) < 0.005);
  $("#camAspectSel").value = opt ? opt.value : "";
}
const wrapAz = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
// moving the camera view never re-meters (use "Meter now" for a new reading)
const camMoved = () => touch();
function zoomCam(ev) {
  ev.preventDefault();
  S.cam.hfov = clampFov(S.cam.hfov * Math.pow(1.1, Math.sign(ev.deltaY)));
  syncCamInputs(); camMoved();
}

// camera view: drag = pan (grab the image), wheel = zoom
camCv.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  const rect = camCv.getBoundingClientRect(), x0 = ev.clientX, y0 = ev.clientY;
  const yaw0 = S.cam.yaw, pit0 = S.cam.pitch;
  const vfov = (2 * Math.atan(Math.tan((S.cam.hfov * Math.PI) / 360) / S.cam.aspect) * 180) / Math.PI;
  camCv.style.cursor = "grabbing";
  const move = (e) => {
    S.cam.yaw = wrapAz(yaw0 - ((e.clientX - x0) / rect.width) * S.cam.hfov);
    S.cam.pitch = Math.max(-89, Math.min(89, pit0 + ((e.clientY - y0) / rect.height) * vfov));
    syncCamInputs(); touch();
  };
  const up = () => { camCv.style.cursor = ""; window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); camMoved(); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
});
camCv.addEventListener("wheel", zoomCam, { passive: false });

// full dome: drag the camera frame's border = move the camera, anywhere else = place the sun; wheel = zoom
function eqDir(ev) {
  const rect = eqCv.getBoundingClientRect();
  const u = (ev.clientX - rect.left) / rect.width, v = (ev.clientY - rect.top) / rect.height;
  return { u, v, d: dirOf((u - 0.5) * 360, (0.5 - v) * 180) };
}
// What a pointer position on the dome grabs: the sun marker wins, then the frame BORDER (within a few px);
// everything else — including the inside of the frame — places the sun.
function eqGrab(ev) {
  const rect = eqCv.getBoundingClientRect(), w = rect.width, h = rect.height;
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const sx = ((((P.sun.az / 360 + 0.5) % 1) + 1) % 1) * w, sy = (0.5 - P.sun.el / 180) * h;
  const sunHit = Math.min(Math.hypot(x - sx, y - sy), Math.hypot(x - sx - w, y - sy), Math.hypot(x - sx + w, y - sy));
  if (sunHit <= sunMarkerR(w) + 5) return "sun";
  const pts = camFrameOutline(w, h), tol = 7;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (Math.abs(x1 - x0) >= w / 2) continue;                 // wrap-around break
    const dx = x1 - x0, dy = y1 - y0, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / L2));
    if (Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= tol) return "frame";
  }
  return "sky";
}
const setFrameHot = (on) => { if (!!S.eqFrameHot !== on) { S.eqFrameHot = on; touch(); } };
eqCv.addEventListener("pointermove", (ev) => {
  if (ev.buttons) return;
  const g = eqGrab(ev);
  eqCv.style.cursor = g === "frame" ? "move" : g === "sun" ? "grab" : "crosshair";
  setFrameHot(g === "frame");
});
eqCv.addEventListener("pointerleave", () => { if (!H.ptrDown) setFrameHot(false); });
eqCv.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  const p0 = eqDir(ev);
  if (eqGrab(ev) === "frame") {
    setFrameHot(true);
    const yaw0 = S.cam.yaw, pit0 = S.cam.pitch;
    const move = (e) => {
      const p = eqDir(e);
      S.cam.yaw = wrapAz(yaw0 + (p.u - p0.u) * 360);
      S.cam.pitch = Math.max(-89, Math.min(89, pit0 - (p.v - p0.v) * 180));
      syncCamInputs(); touch();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setFrameHot(false); camMoved(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return;
  }
  const set = (e) => {
    const { u, v } = eqDir(e);
    P.sun.az = Math.round(wrapAz((u - 0.5) * 360) * 2) / 2;
    P.sun.el = Math.round(Math.max(-15, Math.min(90, (0.5 - v) * 180)) * 10) / 10;
    syncUI();
  };
  set(ev);
  const up = () => { window.removeEventListener("pointermove", set); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", set); window.addEventListener("pointerup", up);
});
eqCv.addEventListener("wheel", zoomCam, { passive: false });

// ------------------------------------------------------------------ presets
let presets = [];
async function loadPresets(selectId) {
  presets = await (await fetch("/api/presets")).json();
  const sel = $("#presetSel"); sel.innerHTML = "";
  for (const p of presets) { const o = document.createElement("option"); o.value = p.id; o.textContent = p.name; sel.appendChild(o); }
  if (selectId) sel.value = selectId;
}
$("#presetSel").addEventListener("change", (e) => {
  const p = presets.find((x) => x.id === e.target.value);
  if (p) { P = mergeDefaults(p.params); selStop = 0; S.needMeter = !presetHasEV(p.params); syncUI(); $("#outName").value = p.id; log(`Preset: ${p.name}`); }
});
// Save preset: inline name field in the header (prompt() isn't available in every browser, e.g. embedded ones)
const presetBox = $("#presetSaveBox"), presetName = $("#presetName");
const presetIdOf = (n) => n.trim().replace(/[^A-Za-z0-9_\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
// an existing preset with this name (or file id) is overwritten in place instead of duplicated
const presetMatch = (n) => presets.find((p) => p.name.trim().toLowerCase() === n.trim().toLowerCase() || p.id === presetIdOf(n));
function updatePresetHint() {
  const id = presetIdOf(presetName.value);
  $("#presetSaveOk").textContent = presetMatch(presetName.value) ? "Overwrite" : "Save";
  $("#presetSaveOk").disabled = !id;
}
$("#savePreset").addEventListener("click", () => {
  presetName.value = $("#presetSel").selectedOptions[0]?.textContent || "My sky";
  presetBox.hidden = false; $("#savePreset").hidden = true;
  updatePresetHint(); presetName.focus(); presetName.select();
});
const closePresetBox = () => { presetBox.hidden = true; $("#savePreset").hidden = false; };
async function savePresetNow() {
  const name = presetName.value.trim(); if (!presetIdOf(name)) return;
  try {
    const m = presetMatch(name);
    const r = await (await fetch("/api/presets/save", { method: "POST", body: JSON.stringify({ name, id: m ? m.id : undefined, params: P }) })).json();
    if (r.ok === false) throw new Error(r.error);
    await loadPresets(r.id); log(`Saved preset "${name}"`); closePresetBox();
  } catch (e) { log("Saving the preset failed: " + e.message, "err"); }
}
presetName.addEventListener("input", updatePresetHint);
presetName.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") { ev.preventDefault(); savePresetNow(); }
  else if (ev.key === "Escape") { ev.preventDefault(); closePresetBox(); }
});
$("#presetSaveOk").addEventListener("click", savePresetNow);
$("#presetSaveCancel").addEventListener("click", closePresetBox);

// ------------------------------------------------------------------ export
async function postJSON(url, obj) {
  const r = await fetch(url, { method: "POST", body: JSON.stringify(obj || {}) });
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(j.error || r.statusText);
  return j;
}
async function exportEXR() {
  if (!floatOK) throw new Error("This GPU/browser lacks EXT_color_buffer_float.");
  const W = +$("#outRes").value, H = W / 2;
  const half = false;                              // the end result is always 32-bit float
  const maxW = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0]);
  if (W > maxW) throw new Error(`This GPU renders at most ${maxW} px wide — choose a smaller resolution.`);
  const name = $("#outName").value || "sky";
  const btns = $$("#btnExport, #btnSend"); btns.forEach((b) => (b.disabled = true));
  calibrate(W);                                   // sun Ω for this exact resolution
  const separate = P.sun.mode === "separate" && P.sun.disc && S.sunRad > 0;
  const pass = async (label, beginOpts, drawOpts) => {
    const begin = await postJSON("/api/export/begin", { width: W, height: H, half, name, params: P, ...beginOpts });
    const strip = Math.max(16, Math.min(H, Math.floor((16 * 1024 * 1024) / (W * 16))));
    const fbo = makeFBO(W, strip);
    const buf = new Float32Array(W * strip * 4);
    for (let y0 = 0; y0 < H; y0 += strip) {
      const rows = Math.min(strip, H - y0);
      setCommonUniforms();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.fb);
      draw(0, 1, W, rows, { resW: W, resH: H, y0, ...drawOpts });
      gl.readPixels(0, 0, W, rows, gl.RGBA, gl.FLOAT, buf);
      const rgb = new Float32Array(W * rows * 3);
      for (let i = 0, j = 0; i < W * rows * 4; i += 4, j += 3) { rgb[j] = buf[i]; rgb[j + 1] = buf[i + 1]; rgb[j + 2] = buf[i + 2]; }
      const r = await fetch(`/api/export/chunk?id=${begin.id}&y0=${y0}&rows=${rows}`, { method: "POST", body: rgb.buffer });
      if (!r.ok) throw new Error("chunk upload failed");
      $("#exportInfo").textContent = `${label}… ${Math.round(((y0 + rows) / H) * 100)}%`;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); fbo.free();
    return postJSON("/api/export/end", { id: begin.id, preview_png: drawOpts.sunOnly ? null : eqCv.toDataURL("image/png") });
  };
  try {
    const t0 = performance.now();
    const res = await pass("Sky", {}, { grain: P.grain, noSun: separate });
    if (separate) {
      res.sun = await pass("Sun", { exact_name: res.file.replace(/\.exr$/, "") + "_sun" }, { sunOnly: true });
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    $("#exportInfo").innerHTML = `Saved <b>${res.file}</b> (${res.mb} MB, 32-bit float)` +
      (res.sun ? `<br>+ <b>${res.sun.file}</b> (${res.sun.mb} MB, 32-bit float)` : "") +
      ` in ${secs}s<br>sky peak ${res.stats.max.toFixed(2)} · mean sky ${res.stats.mean_upper.toFixed(3)}` +
      (res.note ? `<br>${res.note}` : "") + (res.sun && res.sun.note ? `<br>${res.sun.note}` : "");
    log(`Exported ${res.path}` + (res.sun ? ` + ${res.sun.file}` : "") +
      ` · sky ${fmtLux(P.light.skyLux)}, sun ${fmtLux(S.sunRad > 0 ? P.light.sunLux : 0)} · camera ${S.camEV.toFixed(2)} EV`);
    res.camEV = S.camEV;
    res.camScale = S.camScale;
    S.lastExport = res;
    return res;
  } finally {
    btns.forEach((b) => (b.disabled = false));
    touch();
  }
}
$("#btnExport").addEventListener("click", () => exportEXR().catch((e) => log("Export failed: " + e.message, "err")));

// ------------------------------------------------------------------ Houdini
// Settings (connection, camera, dome, send options) live on the server (app/settings.json) and are edited in the
// "Houdini settings" page; S.hou mirrors them here.
S.hou = { host: "127.0.0.1", port: 8100, camera: "/obj/cam1", domeName: "HDRI_Designer_Dome", domeRy: 0,
  disableOtherDomes: true, setCameraEV: true };
S.houCameras = [];
async function loadHouSettings() {
  try {
    const r = await (await fetch("/api/settings")).json();
    if (r.houdini) S.hou = r.houdini;
    if (r.outputDir) $("#hsOutDir").textContent = r.outputDir;
  } catch (e) { log("Couldn't load Houdini settings: " + e.message, "err"); }
  fillHouForm();
}
let houSaveTimer = 0;
function saveHouSettings(patch, then) {
  Object.assign(S.hou, patch);
  clearTimeout(houSaveTimer);
  houSaveTimer = setTimeout(async () => {
    try {
      const r = await postJSON("/api/settings", { houdini: S.hou });
      S.hou = r.houdini; fillHouForm(true);
      if (then) then();
    } catch (e) { log("Saving Houdini settings failed: " + e.message, "err"); }
  }, 250);
}
function fillHouForm(keepFocus) {
  const set = (id, v) => { const el = $(id); if (!(keepFocus && document.activeElement === el)) el.value = v; };
  set("#hsHost", S.hou.host); set("#hsPort", S.hou.port); set("#hsDome", S.hou.domeName); set("#hsRy", S.hou.domeRy);
  $("#hsDisable").checked = !!S.hou.disableOtherDomes; $("#hsSetEV").checked = !!S.hou.setCameraEV;
  const cs = $("#hsCamera"), cams = [...new Set([...S.houCameras, S.hou.camera])];
  cs.innerHTML = "";
  for (const c of cams) { const o = document.createElement("option"); o.value = c; o.textContent = c + (S.houCameras.includes(c) ? "" : " (not in scene)"); cs.appendChild(o); }
  cs.value = S.hou.camera;
  $("#camSync").title = `Read lens / pitch / direction from ${S.hou.camera} (change in Houdini settings)`;
}
async function houPing() {
  const pill = $("#houStatus"), st = $("#hsStatus");
  try {
    const r = await (await fetch("/api/houdini/ping")).json();
    if (!r.ok) throw new Error(r.error);
    pill.textContent = "Houdini " + r.version; pill.className = "pill ok"; pill.title = (r.hip || "") + " — click for Houdini settings";
    st.textContent = "connected"; st.className = "pill ok";
    $("#hsInfo").innerHTML = `Houdini ${r.version} · scene <code>${(r.hip || "untitled").replace(/</g, "&lt;")}</code>`;
    const sc = await (await fetch("/api/houdini/scene")).json();
    S.houCameras = sc.cameras || [];
    // first connection: if the stored camera isn't in this scene, take the scene's first camera
    if (S.houCameras.length && !S.houCameras.includes(S.hou.camera)) saveHouSettings({ camera: S.houCameras[0] });
    fillHouForm(true);
    const doms = sc.user_domes.map((d) => `${d.path} (${d.enabled ? "on" : "off"})`).join(", ");
    $("#houInfo").textContent = `Scene domes: ${doms || "none"}` + (sc.designer_dome ? ` · designer dome ${sc.designer_dome.enabled ? "on" : "off"}` : "");
    return true;
  } catch (e) {
    pill.textContent = "Houdini offline"; pill.className = "pill err"; pill.title = String(e.message || e) + " — click for Houdini settings";
    st.textContent = "not connected"; st.className = "pill err";
    $("#hsInfo").innerHTML = `No answer from <code>http://${S.hou.host}:${S.hou.port}</code> — is Houdini running with FXHoudiniMCP? See the setup steps below.`;
    $("#houInfo").textContent = "Houdini not connected — see Houdini settings.";
    return false;
  }
}
// settings page
const openHou = () => { $("#houModal").classList.remove("hidden"); fillHouForm(); houPing(); };
$("#btnHouSettings").addEventListener("click", openHou);
$("#houStatus").addEventListener("click", openHou);
$("#houClose").addEventListener("click", () => $("#houModal").classList.add("hidden"));
$("#hsTest").addEventListener("click", () => { $("#hsStatus").textContent = "testing…"; $("#hsStatus").className = "pill"; saveHouSettings({}, houPing); });
$("#hsRefresh").addEventListener("click", houPing);
$("#hsHost").addEventListener("change", (e) => saveHouSettings({ host: e.target.value }, houPing));
$("#hsPort").addEventListener("change", (e) => saveHouSettings({ port: +e.target.value || 8100 }, houPing));
$("#hsCamera").addEventListener("change", (e) => saveHouSettings({ camera: e.target.value }));
$("#hsDome").addEventListener("change", (e) => saveHouSettings({ domeName: e.target.value }));
$("#hsRy").addEventListener("change", (e) => saveHouSettings({ domeRy: +e.target.value || 0 }));
$("#hsDisable").addEventListener("change", (e) => saveHouSettings({ disableOtherDomes: e.target.checked }));
$("#hsSetEV").addEventListener("change", (e) => saveHouSettings({ setCameraEV: e.target.checked }));
// Mapping between Houdini world directions and this designer's equirect frame, measured by
// rendering a UV-coded HDRI through Redshift: texture azimuth = atan2(x, -z) + dome ry,
// elevation identical (see README "Orientation").
function worldDirToDesignerAz(d) {
  const azW = (Math.atan2(d[0], -d[2]) * 180) / Math.PI;
  return ((((azW + (+S.hou.domeRy || 0)) + 540) % 360) + 360) % 360 - 180;
}
$("#camSync").addEventListener("click", async () => {
  try {
    const c = await (await fetch("/api/houdini/camera?path=" + encodeURIComponent(S.hou.camera || "/obj/cam1"))).json();
    if (c.ok === false) throw new Error(c.error);
    S.cam = { hfov: c.hfov, aspect: c.resx / c.resy, pitch: c.pitch, yaw: worldDirToDesignerAz(c.world_dir) };
    // show the Houdini lens on its own film back
    const fs = $("#camFilm"), ap = String(+(+c.aperture).toFixed(4));
    let o = [...fs.options].find((x) => Math.abs(+x.value - c.aperture) < 0.01);
    if (!o) { o = new Option(`Houdini ${(+c.aperture).toFixed(2)} mm`, ap); fs.add(o); }
    fs.value = o.value;
    S.needMeter = true;                    // new shot → new meter reading
    syncCamInputs(); touch();
    log(`Camera ${c.path}: ${c.focal}mm / ${c.aperture}mm → HFOV ${c.hfov.toFixed(2)}°, VFOV ${c.vfov.toFixed(2)}°, pitch ${c.pitch.toFixed(2)}°, yaw ${S.cam.yaw.toFixed(1)}°`);
  } catch (e) { log("Camera sync failed: " + e.message, "err"); }
});
$("#btnSend").addEventListener("click", async () => {
  try {
    const res = await exportEXR();
    const r = await postJSON("/api/houdini/apply", { path: res.path, sun_path: res.sun ? res.sun.path : null,
      camera_scale: res.camScale, ry: +S.hou.domeRy || 0, disable_user_domes: !!S.hou.disableOtherDomes,
      camera: S.hou.setCameraEV ? (S.hou.camera || "/obj/cam1") : null, camera_ev: res.camEV });
    log(`Dome ${r.dome} ← ${r.map}` + (r.sun_dome ? ` · sun dome ${r.sun_dome} (camera-invisible)` : "") +
      ` · Camera contribution ${res.camScale.toPrecision(3)}` +
      (r.camera ? ` · ${r.camera} Exposure ${res.camEV.toFixed(2)} EV` : "") +
      (r.disabled.length ? ` (disabled ${r.disabled.join(", ")})` : ""));
    houPing();
  } catch (e) { log("Send failed: " + e.message, "err"); }
});

// ------------------------------------------------------------------ reference sampler
// Two sample columns (sun side A, away side B) can be taken from one image; both share one horizon line.
const refCv = $("#refCanvas"); let refImg = null;
const refCols = { A: null, B: null }; let refHorizon = null, refActive = "A";
const REF_BAND = 30;
const REF_COL = { A: "#ffb46b", B: "#8fb4ff" }, REF_NAME = { A: "Sun side", B: "Away side" };
const setRefActive = (sd) => { refActive = sd; $$(".refSide").forEach((b) => b.classList.toggle("active", b.dataset.side === sd)); };
$$(".refSide").forEach((b) => b.addEventListener("click", () => setRefActive(b.dataset.side)));
$("#refClear").addEventListener("click", () => { refCols.A = refCols.B = null; refHorizon = null; setRefActive("A"); sampleRef(); });
$("#refBandTxt").textContent = REF_BAND;
// The reference image comes from the user: drop it (on the sampler or anywhere on the app), open a file, or paste.
// It is read locally in the browser — nothing is uploaded or stored.
let refFileName = "";
const refDrop = $("#refDrop");
const openRefModal = () => { $("#refModal").classList.remove("hidden"); refDrop.classList.toggle("empty", !refImg); };
$("#openRefs").addEventListener("click", openRefModal);
$("#refClose").addEventListener("click", () => $("#refModal").classList.add("hidden"));
$("#refFov").addEventListener("change", () => sampleRef());
$("#refOpenFile").addEventListener("click", () => $("#refFile").click());
$("#refFile").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadRefFile(f); e.target.value = ""; });
refDrop.addEventListener("click", () => { if (refDrop.classList.contains("empty")) $("#refFile").click(); });
const isFileDrag = (ev) => [...(ev.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragover", (ev) => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault(); ev.dataTransfer.dropEffect = "copy";
  if ($("#refModal").classList.contains("hidden")) openRefModal();      // drop anywhere → the sampler opens
  refDrop.classList.add("over");
});
window.addEventListener("dragleave", (ev) => { if (!ev.relatedTarget) refDrop.classList.remove("over"); });
window.addEventListener("drop", (ev) => {
  if (!isFileDrag(ev)) return;
  ev.preventDefault(); refDrop.classList.remove("over");                // never let the browser navigate to the file
  const f = [...ev.dataTransfer.files].find((x) => x.type.startsWith("image/"));
  if (f) loadRefFile(f); else log("That's not an image file — drop a JPG, PNG or WebP.", "err");
});
window.addEventListener("paste", (ev) => {
  const it = [...(ev.clipboardData?.items || [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
  if (!it) return;
  ev.preventDefault(); openRefModal(); loadRefFile(it.getAsFile(), "pasted image");
});
function loadRefFile(file, fallbackName) {
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    if (refImg && refImg.src.startsWith("blob:")) URL.revokeObjectURL(refImg.src);
    refImg = img; refFileName = file.name || fallbackName || "image";
    $("#refName").textContent = `${refFileName} · ${img.naturalWidth}×${img.naturalHeight}`;
    refCols.A = refCols.B = null; refHorizon = null; setRefActive("A");
    $("#refApply").disabled = true; $("#refInfo").textContent = "Click the horizon in a clean patch of sky.";
    refCv.width = img.naturalWidth; refCv.height = img.naturalHeight;
    refDrop.classList.remove("empty");
    sampleRef();
  };
  img.onerror = () => { URL.revokeObjectURL(url); log(`Couldn't read ${file.name || "the image"} as an image.`, "err"); };
  img.src = url;
}
refCv.addEventListener("click", (ev) => {
  const r = refCv.getBoundingClientRect();
  const x = Math.round(((ev.clientX - r.left) / r.width) * refCv.width), y = Math.round(((ev.clientY - r.top) / r.height) * refCv.height);
  const sd = refActive;
  if (!(ev.shiftKey && refHorizon != null)) refHorizon = y;       // shift-click: move only the column
  refCols[sd] = { x };
  // first column set → the next click sets the other side
  if (sd === "A" && !refCols.B) setRefActive("B"); else if (sd === "B" && !refCols.A) setRefActive("A");
  sampleRef();
});
const refSamples = { A: [], B: [] };
// median of a ±REF_BAND column, sampled at fixed elevations above the shared horizon line
function sampleColumn(ctx, col, fpx) {
  const yh = refHorizon - 2;
  const x0 = Math.max(0, col.x - REF_BAND), x1 = Math.min(refCv.width, col.x + REF_BAND);
  if (yh < 4 || x1 <= x0) return { out: [], topE: 0 };
  const data = ctx.getImageData(x0, 0, x1 - x0, yh).data;
  const rowMed = (y) => {
    const ch = [[], [], []];
    for (let x = 0; x < x1 - x0; x++) for (let c = 0; c < 3; c++) ch[c].push(data[(y * (x1 - x0) + x) * 4 + c]);
    return ch.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1] / 255; });
  };
  const topE = (Math.atan(yh / fpx) * 180) / Math.PI;
  const targets = [0, 0.5, 1, 2, 3, 5, 7.5, 10, 13, 16, 20, 25, 30, 40].filter((e) => e <= topE - 0.3);
  const out = [];
  for (const e of targets) {
    const y = Math.round(yh - Math.tan((e * Math.PI) / 180) * fpx);
    const acc = [0, 0, 0]; let n = 0;
    for (let yy = Math.max(0, y - 5); yy <= Math.min(yh - 1, y + 5); yy++) { const m = rowMed(yy); acc[0] += m[0]; acc[1] += m[1]; acc[2] += m[2]; n++; }
    if (n) out.push({ e, y, c: rgbToHex(acc.map((v) => v / n)) });
  }
  return { out, topE };
}
function sampleRef() {
  if (!refImg || !refImg.complete) return;
  const ctx = refCv.getContext("2d"); ctx.drawImage(refImg, 0, 0);
  const fpx = (refCv.height / 2) / Math.tan((+$("#refFov").value * Math.PI) / 360);
  let topE = 0;
  for (const sd of ["A", "B"]) {
    refSamples[sd] = [];
    if (!refCols[sd] || refHorizon == null) continue;
    const r = sampleColumn(ctx, refCols[sd], fpx); refSamples[sd] = r.out; topE = r.topE;
  }
  // overlay (drawn after sampling so the median never sees it)
  if (refHorizon != null) {
    ctx.strokeStyle = "#ffd27a"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, refHorizon); ctx.lineTo(refCv.width, refHorizon); ctx.stroke();
  }
  const fs = Math.max(14, Math.round(refCv.height / 60));
  for (const sd of ["A", "B"]) {
    const col = refCols[sd]; if (!col || refHorizon == null) continue;
    ctx.lineWidth = 3; ctx.strokeStyle = REF_COL[sd]; ctx.strokeRect(col.x - REF_BAND, 0, REF_BAND * 2, refHorizon);
    ctx.font = `600 ${fs}px system-ui`; ctx.fillStyle = REF_COL[sd]; ctx.textAlign = "center";
    ctx.fillText(REF_NAME[sd], col.x, refHorizon + fs + 6);
    // dots: sun side to the right of its column, away side to the left (two close columns don't overlap)
    const dir = sd === "A" ? 1 : -1, dx = col.x + dir * (REF_BAND + 22);
    ctx.font = `${Math.round(fs * 0.9)}px system-ui`; ctx.textAlign = dir > 0 ? "left" : "right";
    for (const s of refSamples[sd]) {
      ctx.fillStyle = s.c; ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(dx, s.y, 12, 0, 7); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.fillText(s.e.toFixed(1) + "°", dx + dir * 18, s.y + 6);
    }
  }
  ctx.textAlign = "left";
  const nA = refSamples.A.length, nB = refSamples.B.length;
  $("#refApply").disabled = nA < 2 && nB < 2;
  $("#refInfo").textContent = refHorizon == null ? "Click the horizon in a clean patch of sky." :
    `Sun side: ${nA ? nA + " stops" : "not set"} · Away side: ${nB ? nB + " stops" : "not set"}` +
    ` · frame covers 0°–${topE.toFixed(1)}° above the horizon` +
    (nA >= 2 && nB >= 2 ? " — applies to both sides separately" : nA >= 2 || nB >= 2 ? ($("#refBoth").checked ? " — applies to both sides (linked)" : " — applies to that side only") : "");
}
$("#refBoth").addEventListener("change", sampleRef);
$("#refApply").addEventListener("click", () => {
  const toStops = (smp) => {
    const st = smp.map((s) => ({ e: s.e, c: s.c }));
    if ($("#refZenith").checked) {
      const last = hexToLab(st[st.length - 1].c), le = st[st.length - 1].e;
      const ext = (dL, db, e) => ({ e, c: labToHex([last[0] + dL, last[1] - 0.002, last[2] + db]) });
      if (le < 35) st.push(ext(-0.03, -0.008, Math.max(35, le + 10)));
      st.push(ext(-0.075, -0.02, 90));
    }
    return st;
  };
  const hasA = refSamples.A.length >= 2, hasB = refSamples.B.length >= 2;
  let msg;
  if (hasA && hasB) {
    P.A = toStops(refSamples.A); P.B = toStops(refSamples.B); P.link = false;
    msg = `sun side (${P.A.length} stops) + away side (${P.B.length} stops)`;
  } else {
    const sd = hasA ? "A" : "B", st = toStops(refSamples[sd]);
    if ($("#refBoth").checked) { P.A = deepCopy(st); P.B = deepCopy(st); P.link = true; msg = `${st.length} stops to both sides (linked)`; }
    else { P[sd] = st; msg = `${st.length} stops to the ${REF_NAME[sd].toLowerCase()}`; }
  }
  syncUI(); $("#refModal").classList.add("hidden");
  log(`Applied sampled ${msg} from ${refFileName}`);
});

// ------------------------------------------------------------------ boot
(async function boot() {
  buildSliders(); buildTicks();
  await loadPresets();
  if (presets.length) { P = mergeDefaults(presets[0].params); $("#outName").value = presets[0].id; }
  S.needMeter = !presetHasEV(presets.length ? presets[0].params : null);   // first reading on start-up
  syncUI(); syncCamInputs();
  await loadLuts(S.view);
  histCommit();                                   // base state of the undo history
  requestAnimationFrame(loop);
  await loadHouSettings();
  houPing();
  window.HDRI = { P: () => P, S, exportEXR, renderAll, readFloat, setCommonUniforms }; // debugging hook
})();
