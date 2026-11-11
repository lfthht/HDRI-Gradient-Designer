"""Python / numpy port of the Prague sky model reference implementation (Wilkie et al. 2021, Vevoda et al. 2022).

Ported from PragueSkyModel.cpp/.h (Copyright 2022 Charles University, Apache License 2.0 — see ref/LICENSE.txt).
Covers what the HDRI designer needs: dataset reading (radiance + transmittance; polarisation is skipped), sky
radiance (computeParameters / evaluateModel / reconstruct) and sun radiance (solar spectrum × transmittance).
Vectorised over view directions; the configuration (sun elevation, visibility, albedo, altitude) is scalar.

Only used offline by tools/prg/build_tables.py — the app itself never loads the dataset.
"""
from __future__ import annotations

import numpy as np

PI = np.pi
PLANET_RADIUS = 6378000.0
SAFETY_ALTITUDE = 50.0
SUN_RADIUS = 0.004654793          # rad (= 0.2667°)
DIST_TO_EDGE = 1571524.413613
ATMOSPHERE_WIDTH = 100000.0
SUN_RAD_START, SUN_RAD_STEP = 280.0, 1.0


def _sun_rad_table() -> np.ndarray:
    """SUN_RAD_TABLE from the reference .cpp (extraterrestrial solar radiance, W·m⁻²·sr⁻¹·nm⁻¹, 280 nm + 1 nm steps)."""
    import os
    import re
    src = open(os.path.join(os.path.dirname(__file__), "ref", "PragueSkyModel.cpp"), encoding="utf-8").read()
    body = src[src.index("SUN_RAD_TABLE[]"):]
    body = body[body.index("{") + 1: body.index("};")]
    return np.array([float(v) for v in re.findall(r"[-+]?\d+\.?\d*(?:[eE][-+]?\d+)?", body)])


class PragueSkyModel:
    def __init__(self, path: str):
        with open(path, "rb") as f:
            self._read_radiance(f)
            self._read_transmittance(f)
        self.sun_rad = _sun_rad_table()

    # ------------------------------------------------------------------ reading
    @staticmethod
    def _i(f):
        return int(np.frombuffer(f.read(4), "<i4")[0])

    @staticmethod
    def _d(f, n):
        return np.frombuffer(f.read(8 * n), "<f8").astype(np.float64)

    def _read_radiance(self, f):
        nv = self._i(f); self.vis = self._d(f, nv)
        na = self._i(f); self.alb = self._d(f, na)
        nh = self._i(f); self.alt = self._d(f, nh)
        ne = self._i(f); self.ele = self._d(f, ne)
        self.channels = self._i(f)
        self.ch_start = float(self._d(f, 1)[0]); self.ch_width = float(self._d(f, 1)[0])
        self.rank = self._i(f)
        ns = self._i(f); self.sun_breaks = self._d(f, ns)
        nz = self._i(f); self.zen_breaks = self._d(f, nz)
        nm = self._i(f); self.emph_breaks = self._d(f, nm)
        configs = self.channels * ne * nh * na * nv
        # one configuration on disk: rank × [sun (ns × half), zenithScale (double), zenith (nz × half)], emph (nm × half)
        fields, off = [], 0
        for r in range(self.rank):
            fields += [(f"s{r}", ("<f2", ns), off)]; off += 2 * ns
            fields += [(f"k{r}", "<f8", off)]; off += 8
            fields += [(f"z{r}", ("<f2", nz), off)]; off += 2 * nz
        fields += [("e", ("<f2", nm), off)]; off += 2 * nm
        dt = np.dtype({"names": [x[0] for x in fields], "formats": [x[1] for x in fields],
                       "offsets": [x[2] for x in fields], "itemsize": off})
        raw = np.frombuffer(f.read(off * configs), dtype=dt, count=configs)
        shape = (nv, na, nh, ne, self.channels)     # file order: visibility, albedo, altitude, elevation, channel
        self.sun = np.stack([raw[f"s{r}"].astype(np.float32) for r in range(self.rank)], 1).reshape(*shape, self.rank, ns)
        self.zen = np.stack([(raw[f"z{r}"].astype(np.float64) / raw[f"k{r}"][:, None]).astype(np.float32)
                             for r in range(self.rank)], 1).reshape(*shape, self.rank, nz)
        self.emph = raw["e"].astype(np.float32).reshape(*shape, nm)

    def _read_transmittance(self, f):
        self.dDim = self._i(f); self.aDim = self._i(f)
        nvis = self._i(f); nalt = self._i(f); self.rankT = self._i(f)
        self.alt_t = np.frombuffer(f.read(4 * nalt), "<f4").astype(np.float64)
        self.vis_t = np.frombuffer(f.read(4 * nvis), "<f4").astype(np.float64)
        nU = self.dDim * self.aDim * self.rankT * nalt
        nV = nvis * self.rankT * self.channels * nalt
        self.U = np.frombuffer(f.read(4 * nU), "<f4").astype(np.float64).reshape(nalt, self.dDim, self.aDim, self.rankT)
        self.V = np.frombuffer(f.read(4 * nV), "<f4").astype(np.float64).reshape(nvis, nalt, self.channels, self.rankT)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _interp_param(q, breaks):
        """getInterpolationParameter, vectorised: (index, factor)."""
        q = np.clip(np.asarray(q, np.float64), breaks[0], breaks[-1])
        nxt = np.searchsorted(breaks[1:], q, side="right") + 1     # upper_bound from breaks.begin()+1
        idx = nxt - 1
        at_end = nxt >= len(breaks)
        hi = breaks[np.minimum(nxt, len(breaks) - 1)]
        lo = breaks[idx]
        fac = np.where(at_end, 0.0, (q - lo) / np.where(at_end, 1.0, hi - lo))
        return idx.astype(np.int64), fac

    def compute_parameters(self, view_dirs: np.ndarray, sun_elev: float, sun_azim: float = 0.0):
        """computeParameters for a viewer at the origin (Z up). view_dirs: (N, 3). Returns dict of arrays."""
        v = np.asarray(view_dirs, np.float64)
        v = v / np.linalg.norm(v, axis=1, keepdims=True)
        c = np.array([0.0, 0.0, -PLANET_RADIUS])
        to_vp = -c                                   # viewpoint at the origin
        to_vp_n = to_vp / np.linalg.norm(to_vp)
        dist_view = np.linalg.norm(to_vp) + SAFETY_ALTITUDE
        shifted = c + to_vp_n * dist_view
        altitude = max(dist_view - PLANET_RADIUS, 0.0)
        sun = np.array([np.cos(sun_azim) * np.cos(sun_elev), np.sin(sun_azim) * np.cos(sun_elev), np.sin(sun_elev)])
        elevation = 0.5 * PI - np.arccos(np.clip(to_vp_n @ sun, -1, 1))
        if dist_view > PLANET_RADIUS:
            look_at = shifted + v
            corr = np.sqrt(dist_view ** 2 - PLANET_RADIUS ** 2) / dist_view
            new_origin = c + to_vp_n * (dist_view - corr)
            cv = look_at - new_origin
            cv = cv / np.linalg.norm(cv, axis=1, keepdims=True)
        else:
            cv = v
        gamma = np.arccos(np.clip(v @ sun, -1, 1))
        sa = sun_elev + PI * 0.5
        shadow_dir = np.array([np.cos(sa) * np.cos(sun_azim), np.cos(sa) * np.sin(sun_azim), np.sin(sa)])
        shadow = np.arccos(np.clip(cv @ shadow_dir, -1, 1))
        zero = np.arccos(np.clip(cv @ to_vp_n, -1, 1))
        theta = np.arccos(np.clip(v @ to_vp_n, -1, 1))
        return {"theta": theta, "gamma": gamma, "shadow": shadow, "zero": zero,
                "elevation": float(elevation), "altitude": float(altitude)}

    # ------------------------------------------------------------------ sky radiance
    def _reconstruct(self, cfg, ch, g, a, z):
        """reconstruct() for one configuration (vis, alb, alt, ele indices) and channel, vectorised over angles."""
        iv, ia, ih, ie = cfg
        sun = self.sun[iv, ia, ih, ie, ch]          # (rank, ns)
        zen = self.zen[iv, ia, ih, ie, ch]          # (rank, nz)
        emph = self.emph[iv, ia, ih, ie, ch]        # (nm,)
        gi, gf = g; ai, af = a; zi, zf = z
        gi1 = np.minimum(gi + 1, sun.shape[1] - 1); ai1 = np.minimum(ai + 1, zen.shape[1] - 1)
        sp = (sun[:, gi1].astype(np.float64) - sun[:, gi]) * gf + sun[:, gi]      # (rank, N)
        zp = (zen[:, ai1].astype(np.float64) - zen[:, ai]) * af + zen[:, ai]
        res = (sp * zp).sum(0)
        zi1 = np.minimum(zi + 1, len(emph) - 1)
        ep = (emph[zi1].astype(np.float64) - emph[zi]) * zf + emph[zi]
        return np.maximum(res * ep, 0.0)

    def sky_radiance(self, params, channel: int, visibility: float, albedo: float) -> np.ndarray:
        """Spectral sky radiance (W·m⁻²·sr⁻¹·nm⁻¹) of one channel for all view directions in params."""
        g = self._interp_param(params["gamma"], self.sun_breaks)
        alpha_src = params["shadow"] if params["elevation"] < 0.0 else params["zero"]
        a = self._interp_param(alpha_src, self.zen_breaks)
        z = self._interp_param(params["zero"], self.emph_breaks)
        vi, vf = self._interp_param(visibility, self.vis)
        bi, bf = self._interp_param(albedo, self.alb)
        hi, hf = self._interp_param(params["altitude"], self.alt)
        ei, ef = self._interp_param(np.degrees(params["elevation"]), self.ele)
        vi, bi, hi, ei = int(vi), int(bi), int(hi), int(ei)
        vf, bf, hf, ef = float(vf), float(bf), float(hf), float(ef)
        cl = lambda i, n: min(i, n - 1)

        # interpolate<>: levels visibility → albedo → altitude → elevation, skipping factors < 1e-6
        def level(lv, idx):
            if lv == 4:
                return self._reconstruct(idx, channel, g, a, z)
            base = [vi, bi, hi, ei][lv]; fac = [vf, bf, hf, ef][lv]; n = [len(self.vis), len(self.alb), len(self.alt), len(self.ele)][lv]
            low = level(lv + 1, idx + (cl(base, n),))
            if fac < 1e-6:
                return low
            high = level(lv + 1, idx + (cl(base + 1, n),))
            return (1.0 - fac) * low + fac * high
        return level(0, ())

    # ------------------------------------------------------------------ transmittance / sun
    def _trans_params(self, theta: float, altitude: float):
        ray_x, ray_y = np.sin(theta), np.cos(theta)
        ray_pos_y = PLANET_RADIUS + altitude
        edge = PLANET_RADIUS + ATMOSPHERE_WIDTH

        def isect(rx, ry, py, rad):
            qa = rx * rx + ry * ry; qb = 2.0 * py * ry; qc = py * py - rad * rad
            disc = qb * qb - 4.0 * qa * qc
            if disc <= 0.0:
                return -1.0
            disc = np.sqrt(disc)
            d1 = (-qb + disc) / (2 * qa); d2 = (-qb - disc) / (2 * qa)
            return min(d1, d2) if (d1 > 0 and d2 > 0) else max(d1, d2)

        if altitude < 0.3:
            dist = isect(ray_x, ray_y, ray_pos_y, edge) if theta <= 0.5 * PI else 0.0
        else:
            dist = isect(ray_x, ray_y, ray_pos_y, PLANET_RADIUS)
            if dist < 0.0:
                dist = isect(ray_x, ray_y, ray_pos_y, edge)
        ix, iy = ray_x * dist, ray_y * dist + ray_pos_y
        idist = np.sqrt(ix * ix + iy * iy)
        alt_p = np.clip(idist - PLANET_RADIUS, 0.0, ATMOSPHERE_WIDTH)
        alt_p = (alt_p / ATMOSPHERE_WIDTH) ** (1.0 / 3.0)
        dst = np.arccos(np.clip(iy / idist, -1, 1)) * PLANET_RADIUS
        dst = min(1.0, np.sqrt(np.sqrt(dst / DIST_TO_EDGE)))

        def nonlerp_param(value, count, power):
            index = min(int(value * count), count - 1)
            fac = 0.0
            if index < count - 1:
                a0, b0 = (index / count) ** power, ((index + 1) / count) ** power
                fac = float(np.clip((value ** power - a0) / (b0 - a0), 0.0, 1.0))
            return index, fac
        return nonlerp_param(alt_p, self.aDim, 3), nonlerp_param(dst, self.dDim, 4)

    def _reconstruct_trans(self, vis_i, alt_i, tp, ch):
        (a_i, a_f), (d_i, d_f) = tp
        coefs = self.V[vis_i, alt_i, ch]
        vals = []
        for a in (a_i, a_i + 1):
            if a < self.aDim:
                for d in (d_i, d_i + 1):
                    if d < self.dDim:
                        vals.append(float(self.U[alt_i, d, a] @ coefs))
        vals += [0.0] * (4 - len(vals))
        t0, t1 = vals[0], vals[1]
        if d_f > 0:
            t0 = (1 - d_f) * vals[0] + d_f * vals[1]
            t1 = (1 - d_f) * vals[2] + d_f * vals[3]
        t0 = max(t0, 0.0)
        if a_f > 0:
            t1 = max(t1, 0.0)
            t0 = (1 - a_f) * t0 + a_f * t1
        return t0

    def transmittance(self, theta: float, altitude: float, visibility: float, channel: int) -> float:
        vi, vf = self._interp_param(visibility, self.vis_t); vi, vf = int(vi), float(vf)
        hi, hf = self._interp_param(altitude, self.alt_t); hi, hf = int(hi), float(hf)
        tp = self._trans_params(theta, altitude)

        def by_alt(v):
            t = self._reconstruct_trans(v, hi, tp, channel)
            if hf > 0:
                t = (1 - hf) * t + hf * self._reconstruct_trans(v, hi + 1, tp, channel)
            return t
        t = by_alt(vi)
        if vf > 0:
            t = (1 - vf) * t + vf * by_alt(vi + 1)
        return t * t                                 # stored as square root

    def sun_radiance_spectrum(self, sun_elev: float, visibility: float, wavelengths: np.ndarray) -> np.ndarray:
        """Sun disc radiance (W·m⁻²·sr⁻¹·nm⁻¹) seen from the ground looking at the sun, per wavelength."""
        p = self.compute_parameters(np.array([[np.cos(sun_elev), 0.0, np.sin(sun_elev)]]), sun_elev, 0.0)
        theta, alt = float(p["theta"][0]), p["altitude"]
        out = np.zeros(len(wavelengths))
        cache = {}
        for k, wl in enumerate(wavelengths):
            if wl < self.ch_start or wl >= self.ch_start + self.channels * self.ch_width:
                continue
            if wl < SUN_RAD_START or wl >= SUN_RAD_START + SUN_RAD_STEP * len(self.sun_rad) - 1:
                continue
            ch = int(np.floor((wl - self.ch_start) / self.ch_width))
            if ch not in cache:
                cache[ch] = self.transmittance(theta, alt, visibility, ch)
            x = (wl - SUN_RAD_START) / SUN_RAD_STEP
            i = int(np.floor(x)); fr = x - i
            out[k] = (self.sun_rad[i] * (1 - fr) + self.sun_rad[i + 1] * fr) * cache[ch]
        return out
