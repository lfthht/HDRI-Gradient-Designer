"""Tiny client for the FXHoudiniMCP hwebserver bridge (POST /api, mcp.execute)."""
import json, sys, urllib.request, urllib.parse, uuid

URL = "http://127.0.0.1:8100/api"

def call(command, **params):
    body = urllib.parse.urlencode({"json": json.dumps(["mcp.execute", [], {
        "command": command, "params": params, "request_id": uuid.uuid4().hex}])}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read().decode())

def py(code, return_expression=None):
    p = {"code": code}
    if return_expression:
        p["return_expression"] = return_expression
    return call("code.execute_python", **p)

if __name__ == "__main__":
    # usage: python hou_rpc.py file.py   (runs file contents in Houdini)
    src = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else sys.stdin.read()
    print(json.dumps(py(src), indent=1, default=str))
