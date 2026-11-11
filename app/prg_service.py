"""Prague sky model ("PRG Clear Sky", Wilkie et al. 2021) evaluated for the designer.

For a sun elevation, visibility and ground albedo it returns
* absolute sky luminance (cd/m²) on a grid of view elevation × azimuth-from-sun (the clear sky is symmetric about
  the sun's vertical plane): elevation e = 90·s² and azimuth difference a = 180·t² for uniform s, t ∈ [0, 1], so the
  grid is dense near the horizon and around the sun,
* direct-normal illuminance of the sun (lux) from the solar spectrum × model transmittance.

Spectral → photometric with the CIE 1931 ȳ (tools/prg/prg_weights.json, built by tools/prg/build_weights.py).
Needs tools/prg/PragueSkyModelDatasetGround.dat; if it's missing, PRG mode is reported as unavailable.
"""
from __future__ import annotations

import json
import os
import sys
import threading

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRG_DIR = os.path.join(ROOT, "tools", "prg")
DATASET = os.path.join(PRG_DIR, "PragueSkyModelDatasetGround.dat")
WEIGHTS = os.path.join(PRG_DIR, "prg_weights.json")

N_EL, N_AZ = 64, 72
EL_MIN = -4.2                      # lowest sun elevation in the dataset (deg)
TWILIGHT_FALLOFF = 0.38            # below the dataset: ×10^(0.38·Δel), same as the IES twilight model

# CIE XYZ → ACEScg (AP1, ACES white) — the ACES reference matrix; AP1 luminance weights as in the app
XYZ_TO_AP1 = np.array([[1.6410233797, -0.3248032942, -0.2364246952],
                       [-0.6636628587, 1.6153315917, 0.0167563477],
                       [0.0117218943, -0.0082844420, 0.9883948585]])
AP1_Y = np.array([0.2722287168, 0.6740817658, 0.0536895174])

_lock = threading.Lock()
_model = None
_weights = None
_cache: dict = {}


def available() -> bool:
    return os.path.isfile(DATASET) and os.path.isfile(WEIGHTS)


def _load():
    global _model, _weights
    if _model is None:
        sys.path.insert(0, PRG_DIR)
        from prague_sky import PragueSkyModel  # noqa: E402
        _model = PragueSkyModel(DATASET)
        with open(WEIGHTS, encoding="utf-8") as f:
            _weights = json.load(f)
        assert (_model.channels, _model.ch_start, _model.ch_width) == (
            _weights["channels"], _weights["channel_start"], _weights["channel_width"]), "weights / dataset mismatch"
    return _model, _weights


def grid_dirs():
    s = np.linspace(0.0, 1.0, N_EL)
    t = np.linspace(0.0, 1.0, N_AZ)
    el = np.radians(90.0 * s * s)
    az = np.radians(180.0 * t * t)
    E, A = np.meshgrid(el, az, indexing="ij")            # (N_EL, N_AZ)
    # model frame: Z up, sun at azimuth 0 (+X)
    d = np.stack([np.cos(E) * np.cos(A), np.cos(E) * np.sin(A), np.sin(E)], -1).reshape(-1, 3)
    return d


def sky_table(sun_el_deg: float, visibility: float, albedo: float) -> dict:
    key = (round(sun_el_deg, 2), round(visibility, 1), round(albedo, 3))
    with _lock:
        if key in _cache:
            return _cache[key]
        m, w = _load()
        el = max(EL_MIN, min(90.0, sun_el_deg))
        scale = 10.0 ** (TWILIGHT_FALLOFF * (sun_el_deg - EL_MIN)) if sun_el_deg < EL_MIN else 1.0
        dirs = grid_dirs()
        p = m.compute_parameters(dirs, np.radians(el), 0.0)
        lum = np.zeros(len(dirs))
        for ch, wy in enumerate(w["channel_ybar_integral"]):
            if wy < 1e-3:
                continue
            lum += m.sky_radiance(p, ch, visibility, albedo) * wy
        lum *= w["Km"] * scale                              # cd/m²
        # sun: direct-normal illuminance; the disc is behind the Earth below the geometric horizon
        sun_lux = 0.0
        sun_rgb = None
        sun_cct = None
        wl = np.asarray(w["sun_wavelengths"])
        # colour from the spectrum at the sun's (clamped) elevation — also kept when the disc is just below the
        # horizon so the last visible colour stays available
        spec = m.sun_radiance_spectrum(np.radians(max(el, 0.0)), visibility, wl)       # W·m⁻²·sr⁻¹·nm⁻¹
        X = float(np.sum(spec * np.asarray(w["sun_xbar"])))
        Y = float(np.sum(spec * np.asarray(w["sun_ybar"])))
        Z = float(np.sum(spec * np.asarray(w["sun_zbar"])))
        if Y > 0:
            ap1 = np.maximum(XYZ_TO_AP1 @ np.array([X, Y, Z]), 0.0)
            ap1 /= max(1e-12, float(ap1 @ AP1_Y))                                         # unit luminance: colour only
            sun_rgb = [round(float(v), 5) for v in ap1]
            x, y = X / (X + Y + Z), Y / (X + Y + Z)
            n = (x - 0.3320) / (0.1858 - y)                                              # McCamy CCT approximation
            sun_cct = float(449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33)
        if sun_el_deg > -0.27:
            omega = 2.0 * np.pi * (1.0 - np.cos(0.004654793))
            sun_lux = float(w["Km"] * Y * 1.0 * omega)
            if sun_el_deg < 0.27:                            # disc partly below the horizon
                sun_lux *= (sun_el_deg + 0.27) / 0.54
        out = {"nEl": N_EL, "nAz": N_AZ, "lum": np.round(lum.reshape(N_EL, N_AZ), 4).ravel().tolist(),
               "sunLux": sun_lux, "sunRGB": sun_rgb, "sunCCT": sun_cct, "el": sun_el_deg, "vis": visibility, "alb": albedo,
               "range": {"el": [EL_MIN, 90.0], "vis": [float(m.vis[0]), float(m.vis[-1])],
                         "alb": [float(m.alb[0]), float(m.alb[-1])]}}
        out["skyLux"] = horizontal_sky_lux(out)
        if len(_cache) > 256:
            _cache.clear()
        _cache[key] = out
        return out


def horizontal_sky_lux(table: dict) -> float:
    """Sky illuminance on a horizontal plane from a table (both halves of the sky)."""
    n_el, n_az = table["nEl"], table["nAz"]
    L = np.asarray(table["lum"]).reshape(n_el, n_az)
    s = np.linspace(0, 1, n_el); t = np.linspace(0, 1, n_az)
    el = np.radians(90 * s * s); az = np.radians(180 * t * t)
    integrand = L * (np.sin(el) * np.cos(el))[:, None]      # L·cosθ·dΩ/(de·da), dΩ = cos(el) de da
    return float(2.0 * np.trapezoid(np.trapezoid(integrand, az, axis=1), el))
