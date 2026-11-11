"""Builds prg_weights.json: what the server needs to turn Prague-model spectra into photometric luminance.

* per-channel luminance weights: the model's sky radiance is constant within each 40 nm channel, so
  Lv = 683 · Σ_ch L_ch · ∫_band ȳ(λ) dλ  (CIE 1931 2° observer)
* ȳ(λ) at 1 nm for the sun spectrum (1 nm table × channel transmittance)

Run once (needs colour-science, any version):  python -I build_weights.py
"""
import json
import os
import warnings

import numpy as np

warnings.filterwarnings("ignore")
import colour  # noqa: E402

cmfs = colour.MSDS_CMFS["CIE 1931 2 Degree Standard Observer"]
wl = cmfs.wavelengths
xbar, ybar, zbar = cmfs.values[:, 0], cmfs.values[:, 1], cmfs.values[:, 2]


def ybar_at(lams):
    return np.interp(lams, wl, ybar, left=0.0, right=0.0)


def cmf_at(lams, v):
    return np.interp(lams, wl, v, left=0.0, right=0.0)


start, width, channels = 320.0, 40.0, 11      # Ground dataset (checked by the server at load time)
fine = np.arange(300.0, 800.0, 0.1)
w_ch = []
for c in range(channels):
    lo, hi = start + c * width, start + (c + 1) * width
    m = (fine >= lo) & (fine < hi)
    w_ch.append(float(ybar_at(fine[m]).sum() * 0.1))
sun_wl = np.arange(360.0, 760.0, 1.0)          # model channels end at 760 nm; ȳ is ~0 below 360 nm
out = {
    "source": "CIE 1931 2 Degree Standard Observer via colour-science " + colour.__version__,
    "channel_start": start, "channel_width": width, "channels": channels,
    "channel_ybar_integral": w_ch,             # nm
    "sun_wavelengths": sun_wl.tolist(),
    "sun_ybar": ybar_at(sun_wl).tolist(),
    "sun_xbar": cmf_at(sun_wl, xbar).tolist(),     # for the sun's colour (CIE XYZ of its spectrum)
    "sun_zbar": cmf_at(sun_wl, zbar).tolist(),
    "Km": 683.0,
}
path = os.path.join(os.path.dirname(__file__), "prg_weights.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(out, f)
print("channel integral of ybar:", [round(x, 3) for x in w_ch], "sum", round(sum(w_ch), 2), "->", path)
