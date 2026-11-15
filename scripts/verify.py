"""Verify the unmodified delivery tree, without network or subprocesses."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
errors = []
for row in manifest["files"]:
    file = root / row["path"]
    if not file.is_file():
        errors.append(row["path"] + ": missing")
        continue
    data = file.read_bytes()
    if len(data) != row["bytes"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
        errors.append(row["path"] + ": changed")
print(json.dumps({"ok": not errors, "checked": len(manifest["files"]), "errors": errors}, ensure_ascii=False))
raise SystemExit(bool(errors))
