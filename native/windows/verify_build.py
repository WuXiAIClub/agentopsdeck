"""Verify local/cross-compiled Windows EXE structure, not native execution."""
import hashlib
import json
from pathlib import Path
import struct
import sys


def verify_windows_executable(file, subsystem):
    data = Path(file).read_bytes()
    if len(data) < 64 or data[:2] != b"MZ":
        raise ValueError("Missing DOS executable header")
    offset = struct.unpack_from("<I", data, 0x3C)[0]
    if offset < 64 or offset + 24 > len(data) or data[offset:offset + 4] != b"PE\0\0":
        raise ValueError("Missing or truncated PE header")
    machine, sections = struct.unpack_from("<HH", data, offset + 4)
    optional_size = struct.unpack_from("<H", data, offset + 20)[0]
    optional = offset + 24
    if machine != 0x8664 or sections < 1 or optional_size < 70 or optional + optional_size + sections * 40 > len(data):
        raise ValueError("Invalid x64 PE layout")
    if struct.unpack_from("<H", data, optional)[0] != 0x20B:
        raise ValueError("Expected PE32+ optional header")
    if struct.unpack_from("<H", data, optional + 68)[0] != subsystem:
        raise ValueError("Unexpected Windows subsystem")
    names = [
        data[optional + optional_size + index * 40:optional + optional_size + index * 40 + 8].rstrip(b"\0")
        for index in range(sections)
    ]
    if subsystem == 2 and b".rsrc" not in names:
        raise ValueError("Launcher resources are missing")
    return {"machine": "x86_64", "subsystem": subsystem, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: verify_build.py SHIPPING_DIRECTORY")
    root = Path(sys.argv[1])
    result = {
        "AgentOpsDeck.exe": verify_windows_executable(root / "AgentOpsDeck.exe", 2),
        "runtime/private-path-check.exe": verify_windows_executable(root / "runtime" / "private-path-check.exe", 3),
    }
    print(json.dumps({"windowsExecutablesVerified": True, "nativeExecutionTested": False, "files": result}, indent=2))
