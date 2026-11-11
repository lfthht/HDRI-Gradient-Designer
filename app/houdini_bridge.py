"""Talks to the running Houdini session through the FXHoudiniMCP hwebserver bridge.

Everything here executes Python inside Houdini via `code.execute_python`; it only sets up the scene (domes, camera exposure) - no rendering.
The designer never touches the user's original dome light except to switch off
its `light_enabled` flag (marked with userData `hdri_designer_disabled`).
"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
import uuid

# Connection + scene naming, set from the app's Houdini settings (server.py → configure()).
CONFIG = {"url": os.environ.get("HDRI_HOUDINI_URL", "http://127.0.0.1:8100/api"), "dome": "HDRI_Designer_Dome"}


def configure(host: str | None = None, port: int | None = None, dome: str | None = None) -> None:
    if host is not None or port is not None:
        h = (host or "127.0.0.1").strip() or "127.0.0.1"
        CONFIG["url"] = f"http://{h}:{int(port or 8100)}/api"
    if dome:
        CONFIG["dome"] = dome


def dome_name() -> str:
    return CONFIG["dome"]


class HoudiniError(RuntimeError):
    pass


def _call(command: str, timeout: float = 600, **params):
    body = urllib.parse.urlencode({"json": json.dumps(["mcp.execute", [], {
        "command": command, "params": params, "request_id": uuid.uuid4().hex}])}).encode()
    req = urllib.request.Request(CONFIG["url"], data=body,
                                 headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        res = json.loads(r.read().decode())
    if res.get("status") != "success":
        raise HoudiniError(json.dumps(res.get("error", res))[:2000])
    return res["data"]


def run(code: str, timeout: float = 600):
    """Execute code in Houdini. The code must assign a JSON-able `RESULT`."""
    data = _call("code.execute_python", timeout=timeout, code=code,
                 return_expression="RESULT")
    if not data.get("success", True) or data.get("error"):
        raise HoudiniError(str(data.get("error") or data)[:4000])
    return data.get("return_value")


def ping() -> dict:
    return run("import hou\nRESULT={'hip': hou.hipFile.path(), 'version': hou.applicationVersionString()}",
               timeout=10)


_COMMON_TEMPLATE = r'''
import hou, math, json
DOME = "/obj/%(dome)s"

def _user_domes():
    return [n for n in hou.node("/obj").children()
            if n.type().name().startswith("rslightdome") and not n.name().startswith("%(dome)s")]
'''


def _common() -> str:
    return _COMMON_TEMPLATE % {"dome": dome_name()}


def scene_info() -> dict:
    code = _common() + r'''
cams = []
for n in hou.node("/obj").allSubChildren():
    if n.type().name() == "cam":
        cams.append(n.path())
rop = hou.node("/out")
rops = [n.path() for n in rop.children() if n.type().name() == "Redshift_ROP"] if rop else []
ours = hou.node(DOME)
RESULT = {
  "hip": hou.hipFile.path(),
  "cameras": cams,
  "rops": rops,
  "user_domes": [{"path": d.path(), "enabled": bool(d.evalParm("light_enabled")),
                  "map": d.evalParm("env_map")} for d in _user_domes()],
  "designer_dome": None if ours is None else {
      "path": ours.path(), "enabled": bool(ours.evalParm("light_enabled")),
      "map": ours.evalParm("env_map"), "ry": ours.evalParm("ry")},
}
'''
    return run(code, timeout=30)


def camera(path: str) -> dict:
    """Field of view + world look direction of a camera."""
    code = _common() + r'''
c = hou.node(%r)
w = c.worldTransform()
fwd = hou.Vector4(0, 0, -1, 0) * w
fx, fy, fz = fwd[0], fwd[1], fwd[2]
L = math.sqrt(fx*fx + fy*fy + fz*fz) or 1
fx, fy, fz = fx/L, fy/L, fz/L
focal = c.evalParm("focal"); aper = c.evalParm("aperture")
resx, resy = c.evalParm("resx"), c.evalParm("resy")
asp = c.evalParm("aspect") if c.parm("aspect") else 1.0
hfov = 2*math.degrees(math.atan(aper*0.5/focal))
vfov = 2*math.degrees(math.atan(math.tan(math.radians(hfov*0.5)) * resy/(resx*asp)))
RESULT = {"path": c.path(), "focal": focal, "aperture": aper, "resx": resx, "resy": resy,
          "hfov": hfov, "vfov": vfov,
          "pitch": math.degrees(math.asin(max(-1, min(1, fy)))),
          "world_dir": [fx, fy, fz]}
''' % path
    return run(code, timeout=30)


def apply_hdri(exr_path: str, rotate_y: float = 0.0, disable_user_domes: bool = True,
               sun_path: str | None = None, camera: str | None = None,
               camera_ev: float | None = None, camera_scale: float = 1.0) -> dict:
    """Create/update the designer dome light(s), pointing at the ACEScg EXR(s).

    With `sun_path`, a second dome carries only the sun disc with background
    visibility off: it lights and reflects, but the camera never sees the disc.
    """
    exr_path = exr_path.replace("\\", "/")
    sun_path = sun_path.replace("\\", "/") if sun_path else None
    code = _common() + r'''
path = %(path)r
sun_path = %(sun)r

def make(name, offset):
    # Always build a fresh node: Redshift can keep stale per-light texture data when env_map /
    # visibility parms of an existing dome change in a session (measured: background rendered from
    # an old, smeared representation). A new node is cheap and always clean.
    old = hou.node("/obj/" + name)
    pos = old.position() if old is not None else None
    if old is not None:
        old.destroy()
    n = hou.node("/obj").createNode("rslightdome", name)
    n.setComment("Created by HDRI Gradient Designer")
    n.setGenericFlag(hou.nodeFlag.DisplayComment, True)
    if pos is not None:
        n.setPosition(pos)
    else:
        others = _user_domes()
        if others:
            n.setPosition(others[0].position() + hou.Vector2(0, offset))
    return n, old is None

def setup(n, file, background):
    def setp(k, v):
        p = n.parm(k)
        if p is not None:
            p.set(v)
    # Redshift decides camera visibility of a dome by its Camera contribution scale (measured),
    # so a dome hidden from the camera needs both Background off and Camera scale 0.
    setp("RSL_cameraScale", 1.0 if background else 0.0)
    setp("env_map", file)
    setp("tex0_colorSpace", "ACEScg")
    setp("tex0_srgb", 0)
    setp("tex0_gamma", 1.0)
    setp("light_intensity", 1.0)
    setp("RSL_exposure", 0.0)
    setp("RSL_saturation", 100.0)
    for c in ("light_colorr", "light_colorg", "light_colorb"):
        setp(c, 1.0)
    setp("background_enable", 1 if background else 0)
    setp("rx", 0.0); setp("rz", 0.0)
    setp("ry", %(ry)r)
    setp("light_enabled", 1)

d, created = make("%(dome)s", -1.5)
setup(d, path, True)
# background toned down for the camera only (primary rays); light values stay physical
d.parm("RSL_cameraScale").set(%(camscale)r)
old_plate = hou.node("/obj/%(dome)s_Plate")      # earlier backplate approach - no longer used
if old_plate is not None:
    old_plate.destroy()
sun_dome = None
sd = hou.node("/obj/%(dome)s_Sun")
if sun_path:
    sd, _ = make("%(dome)s_Sun", -3.0)
    setup(sd, sun_path, False)
    sun_dome = sd.path()
elif sd is not None:
    sd.destroy()
disabled = []
if %(disable)r:
    for o in _user_domes():
        if o.evalParm("light_enabled"):
            o.parm("light_enabled").set(0)
            o.setUserData("hdri_designer_disabled", "1")
            disabled.append(o.path())
# make Redshift re-read the file if it changed on disk
try:
    hou.hscript("texcache -c")
except Exception:
    pass
# Redshift camera exposure: HDRI is in physical units (1.0 = 683 cd/m2), the camera brings the plate back
cam_path = None
if %(cam)r and %(ev)r is not None:
    c = hou.node(%(cam)r)
    if c is not None and c.parm("RS_campro_PyCamExposureEV") is not None:
        if c.userData("hdri_designer_orig_ev") is None:
            c.setUserData("hdri_designer_orig_ev", "%%r|%%s" %% (c.evalParm("RS_campro_PyCamExposureEV"),
                                                              c.parm("RS_campro_PyCamExposureType").evalAsString()))
        c.parm("RS_campro_PyCamExposureType").set("ev_only")
        c.parm("RS_campro_PyCamExposureEV").set(%(ev)r)
        cam_path = c.path()
RESULT = {"dome": d.path(), "created": created, "map": path, "sun_dome": sun_dome,
          "camera_scale": d.evalParm("RSL_cameraScale"), "disabled": disabled, "camera": cam_path}
''' % {"path": exr_path, "sun": sun_path, "camscale": float(camera_scale), "dome": dome_name(), "ry": float(rotate_y),
       "disable": bool(disable_user_domes), "cam": camera,
       "ev": None if camera_ev is None else round(float(camera_ev), 4)}
    return run(code, timeout=60)
