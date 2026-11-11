"""Minimal, dependency-free (numpy + zlib) OpenEXR writer.

Scanline RGB image, ZIP compression (16 lines/block), HALF or FLOAT channels,
tagged with ACES AP1 chromaticities so DCCs can identify ACEScg data.
"""
from __future__ import annotations

import struct
import zlib
from concurrent.futures import ThreadPoolExecutor

import numpy as np

# ACEScg (AP1) primaries + ACES white point (approx. D60)
AP1_CHROMATICITIES = (0.713, 0.293, 0.165, 0.830, 0.128, 0.044, 0.32168, 0.33767)

_HALF, _FLOAT = 1, 2
_ZIP = 3
_LINES_PER_BLOCK = 16


def _attr(name: str, typ: str, data: bytes) -> bytes:
    return name.encode() + b"\0" + typ.encode() + b"\0" + struct.pack("<i", len(data)) + data


def _zip_block(raw: bytes) -> bytes:
    a = np.frombuffer(raw, np.uint8)
    # 1) split even / odd bytes   2) delta predictor   3) zlib
    reordered = np.concatenate([a[0::2], a[1::2]])
    pred = reordered.copy()
    pred[1:] = (reordered[1:].astype(np.int16) - reordered[:-1].astype(np.int16) + 128) & 0xFF
    comp = zlib.compress(pred.tobytes(), 6)
    return comp if len(comp) < len(raw) else raw


def write_exr(path: str, rgb: np.ndarray, half: bool = True, extra_attrs: dict | None = None) -> None:
    """Write an HxWx3 float array as a scanline ZIP EXR.

    Streams block by block: each 16-line block is converted, compressed and written on its own, so memory stays
    at the size of the input array (a 16K × 8K float image is 1.6 GB; full-image copies would multiply that).
    """
    rgb = np.asarray(rgb)
    h, w, c = rgb.shape
    assert c == 3
    ptype = _HALF if half else _FLOAT
    dtype = np.dtype("<f2") if half else np.dtype("<f4")
    big = 65504.0 if half else 3.0e38

    # channels must be sorted alphabetically: B, G, R
    chl = b""
    for ch in (b"B", b"G", b"R"):
        chl += ch + b"\0" + struct.pack("<iB3xii", ptype, 0, 1, 1)
    chl += b"\0"

    hdr = b"\x76\x2f\x31\x01" + struct.pack("<i", 2)
    hdr += _attr("channels", "chlist", chl)
    hdr += _attr("compression", "compression", bytes([_ZIP]))
    hdr += _attr("dataWindow", "box2i", struct.pack("<iiii", 0, 0, w - 1, h - 1))
    hdr += _attr("displayWindow", "box2i", struct.pack("<iiii", 0, 0, w - 1, h - 1))
    hdr += _attr("lineOrder", "lineOrder", bytes([0]))
    hdr += _attr("pixelAspectRatio", "float", struct.pack("<f", 1.0))
    hdr += _attr("screenWindowCenter", "v2f", struct.pack("<ff", 0.0, 0.0))
    hdr += _attr("screenWindowWidth", "float", struct.pack("<f", 1.0))
    hdr += _attr("chromaticities", "chromaticities", struct.pack("<8f", *AP1_CHROMATICITIES))
    for k, v in (extra_attrs or {}).items():
        hdr += _attr(k, "string", str(v).encode("utf-8"))
    hdr += b"\0"

    starts = list(range(0, h, _LINES_PER_BLOCK))

    def build(y0):
        blk = np.array(rgb[y0:y0 + _LINES_PER_BLOCK], dtype=np.float32)          # small copy of 16 lines
        np.nan_to_num(blk, copy=False, nan=0.0, posinf=big, neginf=-big)
        np.clip(blk, -big, big, out=blk)
        # planar per scanline: [B row][G row][R row]
        planar = np.ascontiguousarray(blk[:, :, ::-1].transpose(0, 2, 1).astype(dtype))
        return _zip_block(planar.tobytes())

    table_pos = len(hdr)
    table = []
    with open(path, "wb") as f:
        f.write(hdr)
        f.write(b"\0" * (8 * len(starts)))                                       # offset table, filled at the end
        offset = table_pos + 8 * len(starts)
        batch = 256                                                              # blocks compressed in parallel
        with ThreadPoolExecutor() as ex:
            for i in range(0, len(starts), batch):
                part = starts[i:i + batch]
                for y0, b in zip(part, ex.map(build, part)):
                    table.append(offset)
                    f.write(struct.pack("<ii", y0, len(b)))
                    f.write(b)
                    offset += 8 + len(b)
        f.seek(table_pos)
        f.write(struct.pack("<%dQ" % len(table), *table))
