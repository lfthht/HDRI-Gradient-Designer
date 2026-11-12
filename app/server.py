"""HDRI Gradient Designer - local server.

    python server.py            -> http://127.0.0.1:8765

Serves the UI, stores presets, receives float pixel strips rendered by the
browser's WebGL2 sky shader, writes ACEScg OpenEXR files and talks to Houdini.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import exr  # noqa: E402
import houdini_bridge as hb  # noqa: E402
import prg_service  # noqa: E402

STATIC = os.path.join(HERE, "static")
PRESETS = os.path.join(HERE, "presets")
OUTPUT = os.path.join(ROOT, "output")
for d in (PRESETS, OUTPUT):
    os.makedirs(d, exist_ok=True)

PORT = int(os.environ.get("HDRI_DESIGNER_PORT", "8765"))

# Houdini settings (edited in the app's "Houdini settings" page, stored next to the server)
SETTINGS_FILE = os.path.join(HERE, "settings.json")
HOUDINI_DEFAULTS = {"host": "127.0.0.1", "port": 8100, "camera": "/obj/cam1", "domeName": "HDRI_Designer_Dome",
                    "domeRy": 0.0, "disableOtherDomes": True, "setCameraEV": True}


def _load_settings() -> dict:
    s = {"houdini": dict(HOUDINI_DEFAULTS)}
    try:
        with open(SETTINGS_FILE, encoding="utf-8") as fh:
            s["houdini"].update(json.load(fh).get("houdini", {}))
    except (OSError, ValueError):
        pass
    return s


def _clean_houdini(h: dict) -> dict:
    out = dict(HOUDINI_DEFAULTS)
    out.update({k: v for k, v in h.items() if k in HOUDINI_DEFAULTS})
    out["host"] = re.sub(r"[^A-Za-z0-9.\-:\[\]]", "", str(out["host"])) or "127.0.0.1"
    out["port"] = max(1, min(65535, int(out["port"])))
    out["domeName"] = re.sub(r"[^A-Za-z0-9_]", "_", str(out["domeName"])).strip("_") or "HDRI_Designer_Dome"
    out["camera"] = str(out["camera"]) or "/obj/cam1"
    out["domeRy"] = float(out["domeRy"])
    out["disableOtherDomes"] = bool(out["disableOtherDomes"]); out["setCameraEV"] = bool(out["setCameraEV"])
    return out


SETTINGS = _load_settings()
SETTINGS["houdini"] = _clean_houdini(SETTINGS["houdini"])


def _apply_houdini_settings():
    h = SETTINGS["houdini"]
    hb.configure(host=h["host"], port=h["port"], dome=h["domeName"])


_apply_houdini_settings()
HALF_MAX = 65504.0

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _safe_name(s: str, default="sky") -> str:
    s = re.sub(r"[^A-Za-z0-9_\-]+", "_", (s or "").strip()).strip("_")
    return s[:80] or default


def _next_version(base: str) -> str:
    v = 1
    for f in os.listdir(OUTPUT):
        m = re.match(re.escape(base) + r"_v(\d{3})\.exr$", f)
        if m:
            v = max(v, int(m.group(1)) + 1)
    return f"{base}_v{v:03d}"


class Handler(BaseHTTPRequestHandler):
    server_version = "HDRIDesigner/1.0"

    # ---------- helpers
    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("%s\n" % (fmt % args))

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _file(self, base: str, rel: str):
        path = os.path.normpath(os.path.join(base, rel))
        if not path.startswith(os.path.normpath(base)) or not os.path.isfile(path):
            return self._send(404, b"not found", "text/plain")
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        with open(path, "rb") as f:
            self._send(200, f.read(), ctype)

    # ---------- routing
    def do_GET(self):
        u = urlparse(self.path)
        p = unquote(u.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if p in ("/", "/index.html"):
                return self._file(STATIC, "index.html")
            if p.startswith("/static/"):
                return self._file(STATIC, p[len("/static/"):])
            if p.startswith("/output/"):
                return self._file(OUTPUT, p[len("/output/"):])
            if p == "/api/presets":
                out = []
                for f in sorted(os.listdir(PRESETS)):
                    if f.endswith(".json"):
                        with open(os.path.join(PRESETS, f), encoding="utf-8") as fh:
                            d = json.load(fh)
                        out.append({"id": f[:-5], "name": d.get("name", f[:-5]), "params": d.get("params", d)})
                return self._json(out)
            if p == "/api/exports":
                fs = sorted((f for f in os.listdir(OUTPUT) if f.endswith(".exr") and not f.startswith("_")),
                            key=lambda f: os.path.getmtime(os.path.join(OUTPUT, f)), reverse=True)
                return self._json([{"file": f, "path": os.path.join(OUTPUT, f).replace("\\", "/"),
                                    "mb": round(os.path.getsize(os.path.join(OUTPUT, f)) / 1e6, 1)} for f in fs])
            if p == "/api/prg":
                # Prague sky model luminance table for the exact sun elevation / visibility / albedo
                if not prg_service.available():
                    return self._json({"ok": False, "available": False,
                                       "error": "Prague sky data not found (app/prg_data)"})
                t = prg_service.sky_table(float(q.get("el", 10)), float(q.get("vis", 59.4)), float(q.get("alb", 0.2)))
                return self._json({"ok": True, "available": True, **t})
            if p == "/api/settings":
                return self._json({"ok": True, **SETTINGS, "houdiniDefaults": HOUDINI_DEFAULTS,
                                   "outputDir": OUTPUT.replace("\\", "/")})
            if p == "/api/houdini/ping":
                return self._json({"ok": True, **hb.ping()})
            if p == "/api/houdini/scene":
                return self._json(hb.scene_info())
            if p == "/api/houdini/camera":
                return self._json(hb.camera(q.get("path", "/obj/cam1")))
            return self._send(404, b"not found", "text/plain")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._json({"ok": False, "error": str(e)}, 500)

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if p == "/api/presets/save":
                d = json.loads(self._body())
                pid = _safe_name(d.get("id") or d.get("name"), "preset")   # id = overwrite that preset
                with open(os.path.join(PRESETS, pid + ".json"), "w", encoding="utf-8") as fh:
                    json.dump({"name": d.get("name", pid), "params": d["params"]}, fh, indent=1)
                return self._json({"ok": True, "id": pid})

            if p == "/api/export/begin":
                d = json.loads(self._body())
                w, h = int(d["width"]), int(d["height"])
                job = {"w": w, "h": h, "half": bool(d.get("half", True)),
                       "name": _safe_name(d.get("name")), "params": d.get("params", {}),
                       "exact": _safe_name(d["exact_name"]) if d.get("exact_name") else None,
                       "rgb": np.zeros((h, w, 3), np.float32), "rows": 0, "t0": time.time()}
                jid = uuid.uuid4().hex
                with _jobs_lock:
                    _jobs[jid] = job
                return self._json({"ok": True, "id": jid})

            if p == "/api/export/chunk":
                job = _jobs[q["id"]]
                y0, rows = int(q["y0"]), int(q["rows"])
                a = np.frombuffer(self._body(), np.float32).reshape(rows, job["w"], 3)
                job["rgb"][y0:y0 + rows] = a
                job["rows"] += rows
                return self._json({"ok": True})

            if p == "/api/export/end":
                d = json.loads(self._body())
                with _jobs_lock:
                    job = _jobs.pop(d["id"])
                rgb = job["rgb"]
                mx = float(np.max(rgb))
                half = job["half"]
                note = None
                if half and mx > HALF_MAX:
                    half = False
                    note = "Peak %.0f exceeds half-float range - written as 32-bit float." % mx
                base = job["exact"] or _next_version(f"{job['name']}_{job['w']}x{job['h']}")
                path = os.path.join(OUTPUT, base + ".exr")
                # AP1 luminance on a 1/4 subsample (a full-size copy would be 0.5 GB at 16K)
                lum = rgb[::4, ::4] @ np.array([0.2722287, 0.6740818, 0.0536895], np.float32)
                h = lum.shape[0]
                exr.write_exr(path, rgb, half=half, extra_attrs={
                    "software": "HDRI Gradient Designer",
                    "colorSpace": "ACEScg",
                    "hdriDesigner": json.dumps(job["params"]),
                })
                with open(os.path.join(OUTPUT, base + ".json"), "w", encoding="utf-8") as fh:
                    json.dump({"name": job["name"], "params": job["params"]}, fh, indent=1)
                if d.get("preview_png"):
                    with open(os.path.join(OUTPUT, base + "_preview.png"), "wb") as fh:
                        fh.write(base64.b64decode(d["preview_png"].split(",", 1)[-1]))
                stats = {"max": mx, "mean_upper": float(lum[: h // 2].mean()),
                         "mean_lower": float(lum[h // 2:].mean())}
                return self._json({"ok": True, "path": path.replace("\\", "/"), "file": base + ".exr",
                                   "half": half, "note": note, "mb": round(os.path.getsize(path) / 1e6, 1),
                                   "seconds": round(time.time() - job["t0"], 2), "stats": stats})

            if p == "/api/settings":
                d = json.loads(self._body() or b"{}")
                if "houdini" in d:
                    SETTINGS["houdini"] = _clean_houdini({**SETTINGS["houdini"], **d["houdini"]})
                    _apply_houdini_settings()
                with open(SETTINGS_FILE, "w", encoding="utf-8") as fh:
                    json.dump({"houdini": SETTINGS["houdini"]}, fh, indent=1)
                return self._json({"ok": True, **SETTINGS})
            if p == "/api/houdini/apply":
                d = json.loads(self._body())
                return self._json({"ok": True, **hb.apply_hdri(d["path"], float(d.get("ry", 0.0)),
                                                               bool(d.get("disable_user_domes", True)),
                                                               d.get("sun_path"), d.get("camera"),
                                                               d.get("camera_ev"),
                                                               float(d.get("camera_scale") or 1.0))})
            return self._send(404, b"not found", "text/plain")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return self._json({"ok": False, "error": str(e)}, 500)


def main():
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"HDRI Gradient Designer running on http://127.0.0.1:{PORT}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
