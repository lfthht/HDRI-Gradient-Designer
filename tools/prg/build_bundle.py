"""Builds app/prg_data/: the part of the Prague sky model dataset the designer evaluates, so the app works out of
the box without the 107.6 MB download.

Kept, bit for bit (the dataset's own half floats / floats):
* sky radiance for the channels with a luminance weight (CIE ȳ band integral >= 1e-3, as prg_service.py uses them),
  all visibilities, albedos and sun elevations (the ground dataset has a single altitude);
* sun transmittance for all channels and visibilities, at the two altitude slices around the viewer
  (prague_sky's safety altitude of 50 m) — the only ones the ground viewer interpolates between;
* the extraterrestrial solar spectrum (SUN_RAD_TABLE).
Polarisation is not used. Arrays are byte-shuffled and xz-compressed.

Run once with the full dataset in tools/prg/:   python -I build_bundle.py
Then check:                                     python -I build_bundle.py --verify
"""
import hashlib
import json
import lzma
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from prague_sky import PragueSkyModel  # noqa: E402

DATASET = os.path.join(HERE, "PragueSkyModelDatasetGround.dat")
WEIGHTS = os.path.join(HERE, "prg_weights.json")
OUT = os.path.join(os.path.dirname(os.path.dirname(HERE)), "app", "prg_data")
SOURCE = {"name": "Prague Sky Model dataset, ground level (PragueSkyModelDatasetGround.dat)",
          "url": "https://zenodo.org/records/19140728", "license": "Apache-2.0",
          "md5": "953864f62c9434269b7f909cdff6c7cd"}


def shuffle(a: np.ndarray) -> bytes:
    """Byte planes one after another (all first bytes, then all second bytes, …) — compresses far better."""
    b = np.ascontiguousarray(a).view(np.uint8).reshape(-1, a.dtype.itemsize)
    return np.ascontiguousarray(b.T).tobytes()


def build():
    md5 = hashlib.md5(open(DATASET, "rb").read()).hexdigest()
    assert md5 == SOURCE["md5"], f"unexpected dataset (md5 {md5})"
    m = PragueSkyModel(DATASET, keep_raw=True)
    w = json.load(open(WEIGHTS, encoding="utf-8"))
    chans = [c for c, wy in enumerate(w["channel_ybar_integral"]) if wy >= 1e-3]
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for iv in range(len(m.vis)):
        pick = lambda a: np.ascontiguousarray(a[iv][:, :, :, chans])    # (alb, alt, ele, channel, …)
        sun = pick(m.sun).astype("<f2")                     # read from half floats → lossless
        k = pick(m.zen_k).astype("<f8")
        zr = pick(m.zen_raw).astype("<f2")
        emph = pick(m.emph).astype("<f2")
        assert np.array_equal(sun.astype(np.float32), pick(m.sun)) and np.array_equal(emph.astype(np.float32), pick(m.emph))
        blob = b"".join(shuffle(a) for a in (sun, k, zr, emph))
        data = lzma.compress(blob, preset=9 | lzma.PRESET_EXTREME)
        with open(os.path.join(OUT, f"radiance_v{iv}.xz"), "wb") as f:
            f.write(data)
        total += len(data)
        print(f"radiance_v{iv}.xz  {len(data) / 1e6:.2f} MB")
    # transmittance: the viewer's altitude and the two slices it interpolates between
    p = m.compute_parameters(np.array([[1.0, 0.0, 0.0]]), 0.1)
    hi, _ = m._interp_param(p["altitude"], m.alt_t)
    hs = [int(hi), min(int(hi) + 1, len(m.alt_t) - 1)]
    U = m.U[hs].astype("<f4"); V = m.V[:, hs].astype("<f4")
    data = lzma.compress(shuffle(U) + shuffle(V), preset=9 | lzma.PRESET_EXTREME)
    with open(os.path.join(OUT, "transmittance.xz"), "wb") as f:
        f.write(data)
    total += len(data)
    print(f"transmittance.xz  {len(data) / 1e6:.2f} MB (altitude slices {[float(m.alt_t[h]) for h in hs]} m)")
    meta = {"source": SOURCE, "note": "Subset of the dataset above (see build_bundle.py); values unchanged.",
            "vis": m.vis.tolist(), "alb": m.alb.tolist(), "alt": m.alt.tolist(), "ele": m.ele.tolist(),
            "channels": m.channels, "ch_start": m.ch_start, "ch_width": m.ch_width, "rank": m.rank,
            "sun_breaks": m.sun_breaks.tolist(), "zen_breaks": m.zen_breaks.tolist(),
            "emph_breaks": m.emph_breaks.tolist(), "rad_channels": chans, "sun_rad": m.sun_rad.tolist(),
            "trans": {"dDim": m.dDim, "aDim": m.aDim, "rankT": m.rankT,
                      "alt_t": [float(m.alt_t[h]) for h in hs], "vis_t": m.vis_t.tolist()}}
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)
    print(f"total {total / 1e6:.1f} MB -> {OUT}")


def verify():
    """Compares sky luminance and sun spectra from the bundle against the full dataset."""
    full = PragueSkyModel(DATASET)
    b = PragueSkyModel.from_bundle(OUT)
    w = json.load(open(WEIGHTS, encoding="utf-8"))
    rng = np.random.default_rng(1)
    d = rng.normal(size=(2000, 3)); d[:, 2] = np.abs(d[:, 2]); d /= np.linalg.norm(d, axis=1, keepdims=True)
    worst_sky = worst_sun = 0.0
    for el in (-4.2, -2.0, 0.0, 0.5, 3.0, 7.5, 20.0, 45.0, 89.0):
        for vis in (20.0, 33.0, 59.4, 131.8):
            for alb in (0.0, 0.2, 0.5, 1.0):
                pf = full.compute_parameters(d, np.radians(el)); pb = b.compute_parameters(d, np.radians(el))
                for ch in b.rad_channels:
                    if w["channel_ybar_integral"][ch] < 1e-3:
                        continue
                    a = full.sky_radiance(pf, ch, vis, alb); c = b.sky_radiance(pb, ch, vis, alb)
                    worst_sky = max(worst_sky, float(np.max(np.abs(a - c))))
            wl = np.asarray(w["sun_wavelengths"])
            sa = full.sun_radiance_spectrum(np.radians(max(el, 0)), vis, wl)
            sb = b.sun_radiance_spectrum(np.radians(max(el, 0)), vis, wl)
            worst_sun = max(worst_sun, float(np.max(np.abs(sa - sb))))
    print(f"max |difference|  sky radiance {worst_sky:.3g}  sun spectrum {worst_sun:.3g}")
    assert worst_sky == 0.0 and worst_sun == 0.0, "bundle differs from the dataset"
    print("bundle matches the full dataset exactly")


if __name__ == "__main__":
    verify() if "--verify" in sys.argv else build()
