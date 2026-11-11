# Runs INSIDE Houdini (via hou_rpc.py). Bakes view-transform LUTs from Redshift's OCIO config.
import PyOpenColorIO as ocio, numpy as np, json, os
os.environ["LUTN"]="97"
CFG = r"C:/Program Files/Maxon Redshift 2026/Data/OCIO/config.ocio"
OUT = r"D:/HDRI_Designer/app/static/luts"
N = int(os.environ.get("LUTN","65"))
CCT_MAX = 1.0
cfg = ocio.Config.CreateFromFile(CFG)

def lin_to_cct(x):
    x = np.asarray(x, np.float64)
    return np.where(x <= 0.0078125, 10.5402377416545 * x + 0.0729055341958355,
                    (np.log2(np.maximum(x, 1e-10)) + 9.72) / 17.52)

def apply(proc, rgb):
    cpu = proc.getDefaultCPUProcessor()
    a = np.ascontiguousarray(rgb.astype(np.float32))
    cpu.applyRGB(a)
    return a

def grid(lo, hi):
    v = np.linspace(lo, hi, N)
    b, g, r = np.meshgrid(v, v, v, indexing="ij")  # r fastest in memory
    return np.stack([r, g, b], -1).reshape(-1, 3)

def cct_to_lin(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.155251141552511, (c - 0.0729055341958355) / 10.5402377416545,
                    np.power(2.0, c * 17.52 - 9.72))

meta = {"size": N, "cct_max": CCT_MAX, "display": "sRGB", "views": {}}
for view in ("ACES 1.0 SDR-video", "Un-tone-mapped"):
    key = "aces_sdr" if view.startswith("ACES") else "untonemapped"
    fwd = cfg.getProcessor(ocio.DisplayViewTransform(src="ACEScg", display="sRGB", view=view))
    g = grid(0.0, CCT_MAX)
    out_f = apply(fwd, cct_to_lin(g))
    out_f.astype(np.float32).tofile(os.path.join(OUT, key + "_fwd.bin"))
    inv = cfg.getProcessor(ocio.DisplayViewTransform(src="ACEScg", display="sRGB", view=view,
                                                     direction=ocio.TRANSFORM_DIR_INVERSE))
    gi = grid(0.0, 1.0)
    lin = apply(inv, gi)
    lin_to_cct(lin).astype(np.float32).tofile(os.path.join(OUT, key + "_inv.bin"))
    # sanity: roundtrip a few display greys
    probe = np.array([[0.18, 0.18, 0.18], [0.5, 0.5, 0.5], [0.9, 0.9, 0.9], [1, 1, 1]], np.float32)
    meta["views"][key] = {"name": view,
                          "inv_probe": apply(inv, probe.copy()).round(4).tolist(),
                          "fwd_of_0.18": apply(fwd, np.array([[0.18, 0.18, 0.18]], np.float32)).round(4).tolist()}
json.dump(meta, open(os.path.join(OUT, "luts.json"), "w"), indent=1)
print(json.dumps(meta, indent=1))
