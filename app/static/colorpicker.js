/* Resizable colour picker for every <input type="color"> in the app.
 *
 * Simple: a plain sRGB picker (saturation × brightness square, hue strip, hex, R G B). What you pick is what you
 * see; the app converts it to ACEScg internally through the inverse of Redshift's ACES view.
 * Advanced: adds the perceptual OkLCh plane (lightness × chroma at a hue — the space the gradient is interpolated
 * in) with a chroma zoom for subtle sky colours, the L/C/H sliders, the ACEScg values (also typeable) and overlays
 * for colours outside sRGB or out of reach of the ACES view.
 * Fine control in both: resize at the bottom-right corner, Shift-drag = 10× finer, mouse wheel on a slider row =
 * ±1 step (Shift ×10), exact numbers.
 *
 * It drives the original input (sets .value, fires "input" while editing and "change" on close), so all existing
 * handlers, the undo history and presets work unchanged. Uses the colour helpers from app.js.
 */
(() => {
  const KEY = "hdri.colorpicker";
  let st = {};
  try { st = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { st = {}; }
  st.level = st.level || "simple"; st.mode = st.mode || "lch"; st.cmax = st.cmax || 0.12;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* private mode */ } };
  const adv = () => st.level === "advanced";
  const mode = () => (adv() ? st.mode : "hsv");          // simple mode is always the classic sRGB square

  const el = document.createElement("div");
  el.id = "cp"; el.className = "cp hidden";
  el.innerHTML = `
    <div class="cpHead">
      <span class="cpTitle">Colour</span>
      <span class="btnGroup cpLevel">
        <button class="sm" data-level="simple" title="Plain sRGB picker — the app converts to ACES for you">Simple</button><button class="sm" data-level="advanced" title="OkLCh, chroma zoom, ACEScg values and ACES range overlays">Advanced</button></span>
      <button class="sm cpClose" title="Close (Enter)">✕</button>
      <div class="cpAdvBar adv">
        <span class="btnGroup"><button class="sm" data-mode="lch" title="Perceptual: lightness × chroma at the current hue">OkLCh</button><button class="sm" data-mode="hsv" title="Classic saturation × brightness square">HSV</button></span>
        <label class="cpCmax" title="How much chroma (colourfulness) the field spans from left to right. Sky colours are mostly below 0.07 — a small range spreads them over the whole field for finer control.">Chroma zoom
          <select><option value="0.04">0 – 0.04</option><option value="0.08">0 – 0.08</option><option value="0.12">0 – 0.12</option><option value="0.2">0 – 0.20</option><option value="0.37">0 – 0.37 (all)</option></select></label>
      </div>
    </div>
    <div class="cpBody">
      <div class="cpPlaneBox"><canvas class="cpPlane"></canvas><canvas class="cpStrip"></canvas></div>
      <div class="cpExplain hint adv"></div>
      <div class="cpSwRow">
        <button class="cpOld" title="Original colour — click to revert"></button><div class="cpNew" title="New colour"></div>
        <input class="cpHex" type="text" maxlength="7" spellcheck="false">
        <button class="sm cpDrop" title="Pick a colour from the screen">Pick</button>
        <span class="cpReachBox" title="What Redshift's ACES 1.0 SDR view will actually show for this colour">renders as <span class="cpReach"></span></span>
        <span class="cpGamut"></span>
      </div>
      <div class="cpAces adv" title="The colour you pick is a display colour as seen through Redshift's sRGB / ACES 1.0 SDR-video view. These are the ACEScg values it becomes in the HDRI at EV 0, dome intensity 1 — before the physical light level and camera exposure set the final brightness. Type ACEScg values (e.g. from Redshift or Nuke) to get the matching display colour.">
        <span class="cpAcesLbl">ACEScg</span>
        <input class="cpA" type="number" min="0" step="0.001"><input class="cpA" type="number" min="0" step="0.001"><input class="cpA" type="number" min="0" step="0.001">
        <span class="cpAcesY"></span>
      </div>
      <div class="cpSliders"></div>
      <div class="hint">Shift-drag = 10× finer · wheel on a slider = ±1 step (Shift ×10) · Esc = revert · resize at the corner
        <span class="adv"><br>grey = outside sRGB · greyed-out = the ACES view can't show it (it would render differently)</span></div>
    </div>`;
  document.body.appendChild(el);
  const q = (s) => el.querySelector(s);
  const plane = q(".cpPlane"), strip = q(".cpStrip");

  const ROWS = [
    { k: "L", lbl: "Lightness", min: 0, max: 100, step: 0.1, d: 1, adv: true,
      tip: "OkLCh lightness, 0 = black … 100 = white, perceptually even" },
    { k: "C", lbl: "Chroma", min: 0, max: 0.37, step: 0.001, d: 3, adv: true,
      tip: "OkLCh chroma = colourfulness at the same lightness: 0 = grey, higher = more vivid. Sky colours are mostly 0.01–0.07; the most vivid sRGB colours reach ~0.3." },
    { k: "H", lbl: "Hue °", min: 0, max: 360, step: 0.1, d: 1, adv: true,
      tip: "OkLCh hue angle: ~30 red, ~70 orange, ~110 yellow, ~145 green, ~200 cyan, ~260 blue, ~320 purple" },
    { k: "R", lbl: "R", min: 0, max: 255, step: 1, d: 0, tip: "sRGB red 0–255" },
    { k: "G", lbl: "G", min: 0, max: 255, step: 1, d: 0, tip: "sRGB green 0–255" },
    { k: "B", lbl: "B", min: 0, max: 255, step: 1, d: 0, tip: "sRGB blue 0–255" },
  ];
  const rowEls = {};
  for (const r of ROWS) {
    const lab = document.createElement("span"); lab.textContent = r.lbl; lab.title = r.tip || "";
    const rng = document.createElement("input"); rng.type = "range"; rng.min = r.min; rng.max = r.max; rng.step = r.step; rng.title = r.tip || "";
    const num = document.createElement("input"); num.type = "number"; num.min = r.min; num.max = r.max; num.step = r.step;
    if (r.adv) for (const x of [lab, rng, num]) x.classList.add("adv");
    q(".cpSliders").append(lab, rng, num);
    rowEls[r.k] = { r, rng, num };
    const apply = (v) => { if (!isNaN(v)) setChannel(r.k, Math.min(r.max, Math.max(r.min, v))); };
    rng.addEventListener("input", () => apply(parseFloat(rng.value)));
    num.addEventListener("input", () => apply(parseFloat(num.value)));
    for (const w of [lab, rng, num]) w.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      apply(chan(r.k) - Math.sign(ev.deltaY) * r.step * (ev.shiftKey ? 10 : 1));
    }, { passive: false });
  }

  // ---------------------------------------------------------------- colour state
  // cur.L 0..1, cur.C, cur.H deg (OkLCh, may be outside sRGB), cur.rgb 0..1 (display sRGB, clipped), cur.hsv
  const cur = { L: 0.5, C: 0, H: 0, rgb: [0.5, 0.5, 0.5], hsv: [0, 0, 0.5], inGamut: true };
  let input = null, orig = "#000000", lastHex = "";

  const lchLab = (L, C, H) => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)];
  function lchToRgb(L, C, H) {
    const lin = oklabToLin(lchLab(L, C, H));
    const ok = lin.every((v) => v > -1e-4 && v < 1 + 1e-4);
    return { rgb: lin.map((v) => srgbEncode(Math.min(1, Math.max(0, v)))), ok };
  }
  function rgbToHsv([r, g, b], keepH) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = keepH;
    if (d > 1e-6) {
      h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return [h, mx > 0 ? d / mx : 0, mx];
  }
  function hsvToRgb([h, s, v]) {
    const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    return [f(5), f(3), f(1)];
  }
  function fromLch() {
    const { rgb, ok } = lchToRgb(cur.L, cur.C, cur.H);
    cur.rgb = rgb; cur.inGamut = ok; cur.hsv = rgbToHsv(rgb, cur.hsv[0]);
  }
  function fromRgb(keepHsv) {
    const lab = linToOklab(cur.rgb.map(srgbDecode));
    cur.L = lab[0]; const C = Math.hypot(lab[1], lab[2]);
    if (C > 2e-4) cur.H = ((Math.atan2(lab[2], lab[1]) * 180) / Math.PI + 360) % 360;
    cur.C = C; cur.inGamut = true;
    if (!keepHsv) cur.hsv = rgbToHsv(cur.rgb, cur.hsv[0]);
  }
  const chan = (k) => ({ L: cur.L * 100, C: cur.C, H: cur.H, R: cur.rgb[0] * 255, G: cur.rgb[1] * 255, B: cur.rgb[2] * 255 })[k];
  function setChannel(k, v) {
    if (k === "L" || k === "C" || k === "H") {
      if (k === "L") cur.L = v / 100; else if (k === "C") cur.C = v; else cur.H = ((v % 360) + 360) % 360;
      fromLch();
    } else {
      const i = "RGB".indexOf(k); cur.rgb = cur.rgb.slice(); cur.rgb[i] = v / 255; fromRgb();
    }
    changed(k);
  }
  // ACEScg fields: typed scene-linear values → the display colour the ACES view makes of them
  const aIn = [...el.querySelectorAll(".cpA")];
  aIn.forEach((inp) => inp.addEventListener("input", () => {
    const lin = aIn.map((x) => Math.max(0, parseFloat(x.value) || 0));
    const d = window.acesPicker && window.acesPicker.toDisplay(lin);
    if (!d) return;
    cur.rgb = d.map((v) => Math.min(1, Math.max(0, v))); fromRgb(); changed("A");
  }));
  const reach = (rgb) => (window.acesPicker ? window.acesPicker.reach(rgb) : null);
  const REACH_TOL = 2.5 / 255;
  function loadHex(h) {
    if (!/^#?[0-9a-fA-F]{6}$/.test(h)) return false;
    cur.rgb = hexToRgb(h[0] === "#" ? h : "#" + h); fromRgb(); return true;
  }

  // ---------------------------------------------------------------- drawing
  const OUT_A = [43, 43, 46], OUT_B = [50, 50, 54];      // outside sRGB: neutral grey, faint diagonal lines
  let planeImg = null, planeKey = "";
  function fit(cv) {
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.max(8, Math.round(r.width * dpr)), h = Math.max(8, Math.round(r.height * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return [w, h];
  }
  function drawPlane() {
    const [w, h] = fit(plane), ctx = plane.getContext("2d"), m = mode(), dpr = Math.min(2, devicePixelRatio || 1);
    const key = [m, adv(), m === "lch" ? cur.H.toFixed(2) : cur.hsv[0].toFixed(2), st.cmax, w, h].join("|");
    if (key !== planeKey) {
      planeKey = key; planeImg = ctx.createImageData(w, h); const d = planeImg.data;
      const colAt = (x, y) => (m === "lch"
        ? lchToRgb(1 - y / (h - 1), (x / (w - 1)) * st.cmax, cur.H)
        : { rgb: hsvToRgb([cur.hsv[0], x / (w - 1), 1 - y / (h - 1)]), ok: true });
      // ACES reach (advanced only): error sampled on a grid of nodes and interpolated bilinearly per pixel,
      // so the boundary is a smooth curve instead of grid steps
      let errAt = null;
      if (adv() && window.acesPicker) {
        const g = Math.max(3, Math.ceil(Math.max(w, h) / 90)), gw = Math.ceil((w - 1) / g) + 1, gh = Math.ceil((h - 1) / g) + 1;
        const E = new Float32Array(gw * gh);
        const V = new Uint8Array(gw * gh);              // node inside sRGB (only those count)
        for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
          const c = colAt(Math.min(w - 1, gx * g), Math.min(h - 1, gy * g));
          const r = c.ok ? reach(c.rgb) : null;
          E[gy * gw + gx] = r ? r.err : 0; V[gy * gw + gx] = r ? 1 : 0;
        }
        // the round-trip error is noisy where the inverse view is steep (deep blues): smooth it (3 × 3×3 box
        // passes ≈ Gaussian) so the shaded region has a clean outline instead of blotches
        // weighted by V: only in-sRGB nodes contribute; outside nodes take their neighbours' value (for interpolation)
        const T = new Float32Array(E.length), TW = new Float32Array(E.length), W = Float32Array.from(V);
        for (let p = 0; p < E.length; p++) E[p] *= W[p];
        for (let pass = 0; pass < 6; pass++) {
          for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
            let s = 0, n = 0;
            for (let dx = -1; dx <= 1; dx++) { const xx = gx + dx; if (xx >= 0 && xx < gw) { s += E[gy * gw + xx]; n += W[gy * gw + xx]; } }
            T[gy * gw + gx] = s; TW[gy * gw + gx] = n;
          }
          for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
            let s = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) { const yy = gy + dy; if (yy >= 0 && yy < gh) { s += T[yy * gw + gx]; n += TW[yy * gw + gx]; } }
            E[gy * gw + gx] = s; W[gy * gw + gx] = n;
          }
          for (let p = 0; p < E.length; p++) if (W[p] > 0) { E[p] /= W[p]; W[p] = 1; } else E[p] = 0;
        }
        errAt = (x, y) => {
          const fx = x / g, fy = y / g, x0 = Math.min(gw - 2, fx | 0), y0 = Math.min(gh - 2, fy | 0), tx = fx - x0, ty = fy - y0;
          const a = E[y0 * gw + x0], b = E[y0 * gw + x0 + 1], c = E[(y0 + 1) * gw + x0], e = E[(y0 + 1) * gw + x0 + 1];
          return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
        };
      }
      const period = Math.round(9 * dpr), line = Math.max(1, Math.round(1 * dpr));
      const outCol = (x, y) => (((x + y) % (period * 2)) < line ? OUT_B : OUT_A);
      // pass 1: colour + in-sRGB flag per pixel
      const OK = new Uint8Array(w * h), RGB = new Float32Array(w * h * 3);
      for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
        const c = colAt(x, y); OK[p] = c.ok ? 1 : 0;
        RGB[p * 3] = c.rgb[0]; RGB[p * 3 + 1] = c.rgb[1]; RGB[p * 3 + 2] = c.rgb[2];
      }
      // ACES can't show it → shaded half-way towards the "unavailable" grey, with a soft edge (smooth error field)
      const acesFade = (x, y) => {
        if (!errAt) return 0;
        const t = Math.min(1, Math.max(0, (errAt(x, y) - REACH_TOL * 0.7) / (REACH_TOL * 0.8)));
        return 0.5 * t * t * (3 - 2 * t);
      };
      const OUTM = [(OUT_A[0] + OUT_B[0]) / 2, (OUT_A[1] + OUT_B[1]) / 2, (OUT_A[2] + OUT_B[2]) / 2];
      // pass 2: shade; pixels on the sRGB boundary are anti-aliased with 4×4 sub-samples
      for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p++) {
        const i = p * 4, ok = OK[p];
        const edge = (x > 0 && OK[p - 1] !== ok) || (x < w - 1 && OK[p + 1] !== ok) ||
                     (y > 0 && OK[p - w] !== ok) || (y < h - 1 && OK[p + w] !== ok);
        let r, g, b, cov = ok;
        if (edge) {
          let n = 0; r = g = b = 0;
          for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
            const c = colAt(x - 0.375 + sx * 0.25, y - 0.375 + sy * 0.25);
            if (c.ok) { n++; r += c.rgb[0]; g += c.rgb[1]; b += c.rgb[2]; }
          }
          cov = n / 16;
          if (n) { r /= n; g /= n; b /= n; }
        } else if (ok) { r = RGB[p * 3]; g = RGB[p * 3 + 1]; b = RGB[p * 3 + 2]; }
        const o = edge ? OUTM : outCol(x, y);
        if (!cov) { d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = 255; continue; }
        const f = acesFade(x, y);
        r = r * 255 * (1 - f) + OUTM[0] * f; g = g * 255 * (1 - f) + OUTM[1] * f; b = b * 255 * (1 - f) + OUTM[2] * f;
        d[i] = r * cov + o[0] * (1 - cov); d[i + 1] = g * cov + o[1] * (1 - cov); d[i + 2] = b * cov + o[2] * (1 - cov); d[i + 3] = 255;
      }
    }
    ctx.putImageData(planeImg, 0, 0);
    // marker
    const mx = m === "lch" ? Math.min(1, cur.C / st.cmax) * (w - 1) : cur.hsv[1] * (w - 1);
    const my = m === "lch" ? (1 - cur.L) * (h - 1) : (1 - cur.hsv[2]) * (h - 1);
    const R = Math.max(5 * dpr, w / 60);
    ctx.lineWidth = Math.max(1.5, w / 300);
    ctx.strokeStyle = "#000"; ctx.beginPath(); ctx.arc(mx, my, R + 1, 0, 7); ctx.stroke();
    ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.arc(mx, my, R, 0, 7); ctx.stroke();
    if (m === "lch" && cur.C > st.cmax) {                  // beyond the zoomed range → arrow at the edge
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(w - 1, my); ctx.lineTo(w - 1 - 2 * R, my - R); ctx.lineTo(w - 1 - 2 * R, my + R); ctx.fill();
    }
  }
  function drawStrip() {
    const [w, h] = fit(strip), ctx = strip.getContext("2d"), m = mode(), dpr = Math.min(2, devicePixelRatio || 1);
    const img = ctx.createImageData(w, h), d = img.data, period = Math.round(9 * dpr), line = Math.max(2, Math.round(2 * dpr));
    for (let y = 0; y < h; y++) {
      const H = (y / (h - 1)) * 360;
      let rgb, ok = true, unreach = false;
      if (m === "lch") {
        const r = lchToRgb(cur.L, cur.C, H); rgb = r.rgb; ok = r.ok;
        if (ok && adv()) { const a = reach(rgb); unreach = !!a && !a.ok; }
      } else rgb = hsvToRgb([H, 1, 1]);
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!ok) { const c = ((x + y) % (period * 2)) < line ? OUT_B : OUT_A; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; continue; }
        const f = unreach ? 0.5 : 0;                       // same "half-way to grey" shading as the plane
        d[i] = rgb[0] * 255 * (1 - f) + 46 * f; d[i + 1] = rgb[1] * 255 * (1 - f) + 46 * f; d[i + 2] = rgb[2] * 255 * (1 - f) + 50 * f; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const hy = ((m === "lch" ? cur.H : cur.hsv[0]) / 360) * (h - 1);
    ctx.lineWidth = Math.max(2, h / 250);
    ctx.strokeStyle = "#000"; ctx.strokeRect(0.5, hy - 3, w - 1, 6);
    ctx.strokeStyle = "#fff"; ctx.strokeRect(1.5, hy - 2, w - 3, 4);
  }
  // slider tracks show what moving that slider would do
  function trackBg(k) {
    const r = rowEls[k].r, max = k === "C" ? st.cmaxSlider() : r.max, cs = [];
    for (let i = 0; i <= 16; i++) {
      const v = r.min + ((max - r.min) * i) / 16;
      let rgb;
      if (k === "L") rgb = lchToRgb(v / 100, cur.C, cur.H).rgb;
      else if (k === "C") rgb = lchToRgb(cur.L, v, cur.H).rgb;
      else if (k === "H") rgb = lchToRgb(cur.L, cur.C, v).rgb;
      else { rgb = cur.rgb.slice(); rgb["RGB".indexOf(k)] = v / 255; }
      cs.push(`${rgbToHex(rgb)} ${(i / 16) * 100}%`);
    }
    return `linear-gradient(90deg, ${cs.join(",")})`;
  }
  st.cmaxSlider = () => Math.max(st.cmax, 0.04);
  const EXPLAIN = {
    lch: "<b>Chroma</b> (C) = how colourful a colour is at the same lightness: 0 = grey, higher = more vivid. " +
         "Sky colours are mostly 0.01–0.07, the most vivid sRGB colours ~0.3. <b>Chroma zoom</b> spreads a small range " +
         "over the whole field for fine control. Lightness and chroma are perceptual: equal steps look equal.",
    hsv: "Classic sRGB square: saturation left → right, brightness bottom → top, hue on the strip.",
  };
  function syncControls(skip) {
    const hex = rgbToHex(cur.rgb), m = mode();
    el.classList.toggle("simple", !adv());
    for (const k in rowEls) {
      const { r, rng, num } = rowEls[k];
      if (r.adv && !adv()) continue;
      if (k === "C") rng.max = st.cmaxSlider();
      const v = chan(k);
      rng.value = v;
      if (k !== skip || document.activeElement !== num) num.value = v.toFixed(r.d);
      rng.style.background = trackBg(k);
    }
    if (document.activeElement !== q(".cpHex")) q(".cpHex").value = hex;
    q(".cpNew").style.background = hex;
    q(".cpOld").style.background = orig;
    // ACES: what the stop becomes, and whether the view can show it at all (warning shown in both levels)
    const r = reach(cur.rgb);
    if (r) {
      if (adv()) {
        aIn.forEach((x, i) => { if (skip !== "A" || document.activeElement !== x) x.value = r.lin[i].toFixed(r.lin[i] < 1 ? 4 : 3); });
        const Y = r.lin[0] * 0.2722287 + r.lin[1] * 0.6740818 + r.lin[2] * 0.0536895;
        q(".cpAcesY").textContent = `Y ${Y.toFixed(3)}`;
      }
      q(".cpReachBox").style.display = r.ok ? "none" : "";
      q(".cpReach").style.background = rgbToHex(r.back);
    }
    q(".cpGamut").textContent = adv() && !cur.inGamut ? "outside sRGB — clipped"
      : r && !r.ok ? (adv() ? `ACES view can't show this (off by ${Math.round(r.err * 255)}/255)` : "too vivid / bright for the ACES view")
      : "";
    for (const b of el.querySelectorAll("[data-mode]")) b.classList.toggle("active", b.dataset.mode === st.mode);
    for (const b of el.querySelectorAll("[data-level]")) b.classList.toggle("active", b.dataset.level === st.level);
    q(".cpCmax").style.visibility = m === "lch" ? "visible" : "hidden";
    q(".cpCmax select").value = String(st.cmax);
    q(".cpExplain").innerHTML = EXPLAIN[m];
    drawPlane(); drawStrip();
  }
  // push to the bound input → app handlers (gradient, undo history …)
  function changed(skip) {
    syncControls(skip);
    if (!input) return;
    const hex = rgbToHex(cur.rgb);
    if (hex !== input.value) { input.value = hex; lastHex = hex; input.dispatchEvent(new Event("input", { bubbles: true })); }
  }

  // ---------------------------------------------------------------- plane / strip dragging (Shift = 10× finer)
  function dragOn(cv, onPos) {
    cv.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* not a live pointer */ }
      const r = cv.getBoundingClientRect();
      let fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height, lx = ev.clientX, ly = ev.clientY;
      if (!ev.shiftKey) onPos(fx, fy, true); else [fx, fy] = onPos(null, null, false);  // fine: start from the current value
      const move = (e) => {
        const k = e.shiftKey ? 0.1 : 1;
        if (k === 1) { fx = (e.clientX - r.left) / r.width; fy = (e.clientY - r.top) / r.height; }
        else { fx += ((e.clientX - lx) / r.width) * k; fy += ((e.clientY - ly) / r.height) * k; }
        lx = e.clientX; ly = e.clientY;
        fx = Math.min(1, Math.max(0, fx)); fy = Math.min(1, Math.max(0, fy));
        onPos(fx, fy, true);
      };
      const up = () => { cv.removeEventListener("pointermove", move); cv.removeEventListener("pointerup", up); cv.removeEventListener("pointercancel", up); };
      cv.addEventListener("pointermove", move); cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    });
  }
  dragOn(plane, (fx, fy, set) => {
    const m = mode();
    if (!set) return m === "lch" ? [Math.min(1, cur.C / st.cmax), 1 - cur.L] : [cur.hsv[1], 1 - cur.hsv[2]];
    if (m === "lch") { cur.C = fx * st.cmax; cur.L = 1 - fy; fromLch(); }
    else { cur.hsv = [cur.hsv[0], fx, 1 - fy]; cur.rgb = hsvToRgb(cur.hsv); fromRgb(true); }
    changed();
  });
  dragOn(strip, (fx, fy, set) => {
    const m = mode();
    if (!set) return [0.5, (m === "lch" ? cur.H : cur.hsv[0]) / 360];
    const H = Math.min(359.99, fy * 360);
    if (m === "lch") { cur.H = H; fromLch(); }
    else { cur.hsv = [H, cur.hsv[1], cur.hsv[2]]; cur.rgb = hsvToRgb(cur.hsv); fromRgb(true); }
    changed();
  });

  // ---------------------------------------------------------------- header, swatches, hex, eyedropper
  for (const b of el.querySelectorAll("[data-level]")) b.addEventListener("click", () => { st.level = b.dataset.level; save(); planeKey = ""; syncControls(); });
  for (const b of el.querySelectorAll("[data-mode]")) b.addEventListener("click", () => { st.mode = b.dataset.mode; save(); syncControls(); });
  q(".cpCmax select").addEventListener("change", (e) => { st.cmax = parseFloat(e.target.value); save(); syncControls(); });
  q(".cpClose").addEventListener("click", () => close(false));
  q(".cpOld").addEventListener("click", () => { loadHex(orig); changed(); });
  q(".cpHex").addEventListener("input", (e) => { if (loadHex(e.target.value.trim())) changed(); });
  const dropBtn = q(".cpDrop");
  if (!window.EyeDropper) dropBtn.style.display = "none";
  dropBtn.addEventListener("click", async () => {
    try { const r = await new window.EyeDropper().open(); if (loadHex(r.sRGBHex)) changed(); } catch (e) { /* cancelled */ }
  });
  // move by the header
  q(".cpHead").addEventListener("pointerdown", (ev) => {
    if (ev.target.closest("button, select, label")) return;
    ev.preventDefault();
    const r = el.getBoundingClientRect(), dx = ev.clientX - r.left, dy = ev.clientY - r.top;
    const move = (e) => place(e.clientX - dx, e.clientY - dy, true);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  });
  function place(x, y, remember) {
    const r = el.getBoundingClientRect();
    x = Math.min(innerWidth - r.width - 4, Math.max(4, x)); y = Math.min(innerHeight - r.height - 4, Math.max(4, y));
    el.style.left = x + "px"; el.style.top = y + "px";
    if (remember) { st.x = x; st.y = y; save(); }
  }
  // size is remembered; redraw right after the observer callback (canvases are positioned, so redrawing can't
  // change the layout)
  let rzQueued = false;
  if (window.ResizeObserver) new ResizeObserver(() => {
    if (el.classList.contains("hidden") || rzQueued) return;
    rzQueued = true;
    setTimeout(() => {
      rzQueued = false;
      st.w = el.offsetWidth; st.h = el.offsetHeight; save();
      planeKey = ""; drawPlane(); drawStrip();
    }, 0);
  }).observe(q(".cpPlaneBox"));

  // backstop while open: if the drawn size no longer matches the window (resize events can be delayed or
  // skipped by the browser), redraw. Cheap: only compares a few numbers unless the size really changed.
  setInterval(() => {
    if (!input) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const cv of [plane, strip]) {
      const r = cv.getBoundingClientRect();
      if (Math.abs(cv.width - Math.round(r.width * dpr)) > 1 || Math.abs(cv.height - Math.round(r.height * dpr)) > 1) {
        st.w = el.offsetWidth; st.h = el.offsetHeight; save();
        planeKey = ""; drawPlane(); drawStrip(); return;
      }
    }
  }, 250);

  // ---------------------------------------------------------------- open / close
  function titleFor(inp) {
    if (inp.id === "stopColor") return `${$("#selSideLbl")?.textContent || "Stop"} · stop at ${$("#stopElev")?.value || "?"}°`;
    const lbl = inp.previousElementSibling?.tagName === "LABEL" ? inp.previousElementSibling.textContent : (inp.closest("label")?.textContent || "");
    return (lbl.trim() || inp.dataset.key || "Colour");
  }
  function open(inp) {
    input = inp; orig = inp.value; lastHex = inp.value;
    loadHex(inp.value);
    q(".cpTitle").textContent = titleFor(inp);
    el.classList.remove("hidden");
    el.style.width = Math.min(innerWidth - 8, st.w || 380) + "px";
    el.style.height = Math.min(innerHeight - 8, st.h || 600) + "px";
    if (st.x != null) place(st.x, st.y, false);
    else { const r = inp.getBoundingClientRect(); place(r.right + 10, r.top - 40, false); }
    planeKey = ""; syncControls();
  }
  function close(revert) {
    if (!input) return;
    if (revert && input.value !== orig) { loadHex(orig); changed(); }
    const inp = input; input = null;
    el.classList.add("hidden");
    inp.dispatchEvent(new Event("change", { bubbles: true }));
  }
  // the app changed the bound colour (another stop selected, undo, preset …) → follow it
  window.cpRefresh = () => {
    if (!input || input.value === lastHex) return;
    orig = input.value; lastHex = input.value; loadHex(input.value);
    q(".cpTitle").textContent = titleFor(input); syncControls();
  };

  // replace the browser's picker for every colour input
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.type === "color") { ev.preventDefault(); input === t ? close(false) : (close(false), open(t)); }
  }, true);
  document.addEventListener("keydown", (ev) => {
    const t = ev.target;
    if (t instanceof HTMLInputElement && t.type === "color" && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(t); return; }
    if (!input) return;
    if (ev.key === "Escape") { ev.preventDefault(); close(true); }
    else if (ev.key === "Enter" && !(ev.target instanceof HTMLSelectElement)) { ev.preventDefault(); close(false); }
  }, true);
  // click outside closes (keeps the colour); clicks on gradient stops keep it open and re-target it
  document.addEventListener("pointerdown", (ev) => {
    if (!input || el.contains(ev.target) || ev.target === input) return;
    if (input.id === "stopColor" && ev.target.closest("#gradEditor")) return;
    close(false);
  }, true);
  window.cpOpen = (inp) => open(inp);
})();
