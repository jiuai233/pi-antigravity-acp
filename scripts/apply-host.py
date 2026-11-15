"""Apply the recorded Pi 1.5.2 host snapshot to this kit's local dev dependencies.
Existing development baseline only; not the ACP 0.1.11 terminal-error fix.
Run after npm installation in plugin/. No network, global installation, or AGY.
"""
import hashlib
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
target = root / "plugin/node_modules"
manifest = json.loads((root / "host-reference/overlay.json").read_text(encoding="utf-8"))
def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None

# Validate all bases before changing any file. Do not overwrite a different host.
for row in manifest["files"]:
    package = target / row["package"] / "package.json"
    if not package.is_file():
        raise SystemExit("Missing dev peer: " + row["package"] + "; follow AGENT-HANDOFF.md")
    if json.loads(package.read_text(encoding="utf-8"))["version"] != row["version"]:
        raise SystemExit("Host version mismatch: " + row["package"])
    file = target / row["path"]
    if digest(file) not in {row["base_sha256"], row["sha256"]}:
        raise SystemExit("Host file differs from recorded npm/overlay: " + row["path"])
    if digest(root / "host-reference/overlay" / row["path"]) != row["sha256"]:
        raise SystemExit("Overlay payload changed: " + row["path"])
for row in manifest["files"]:
    file = target / row["path"]
    file.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / "host-reference/overlay" / row["path"], file)
print(json.dumps({"ok": True, "files": len(manifest["files"]), "scope": "kit/plugin/node_modules"}))
