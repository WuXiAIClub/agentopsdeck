"""Pinned Hermes contract POC. Run with python -B; never imports the Hermes backend.

Enforces exact SHA-256 source pins, regular-file containment (no symlinks or path escape),
and stdlib-only AST admission before executing the operator-supplied replay module and
AST-extracted envelope constructor. This is digest + AST admission on trusted operator-supplied
source, NOT an OS filesystem/network sandbox or a Pydantic/backend/model integration test.
The optional --wire flag emits synthetic frames from the verified upstream functions
for AgentOpsDeck's codec tests.
"""

import argparse
import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace

sys.dont_write_bytecode = True
REQUIRED_FILES = (
    "tui_gateway/event_replay.py",
    "tui_gateway/server.py",
    "tui_gateway/entry.py",
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_SOURCE_BYTES = 1024 * 1024
DISALLOWED_CALL_NAMES = {"__import__", "compile", "eval", "exec", "open"}


def parse_args(argv):
    parser = argparse.ArgumentParser(description="Verify pinned Hermes gateway replay/frame contract.")
    parser.add_argument("source_root", help="Directory containing tui_gateway/{event_replay,server,entry}.py")
    parser.add_argument(
        "--expected-sha256",
        required=True,
        help="Inline JSON object or path to JSON manifest mapping required relative paths to 64-hex SHA-256 digests",
    )
    parser.add_argument("--wire", action="store_true", help="Emit JSON-RPC event frames instead of summary JSON")
    return parser.parse_args(argv)


def load_expected_digests(spec_value):
    raw_text = spec_value.strip()
    if raw_text.startswith("{"):
        parsed = json.loads(raw_text)
    else:
        manifest_path = Path(spec_value)
        if manifest_path.is_symlink() or not manifest_path.is_file():
            raise ValueError("Expected SHA-256 manifest must be a regular non-symlink file")
        parsed = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict):
        raise ValueError("Expected SHA-256 manifest must be a JSON object")
    if set(parsed.keys()) != set(REQUIRED_FILES):
        raise ValueError(f"Expected SHA-256 manifest must contain exact keys: {list(REQUIRED_FILES)}")
    normalized = {}
    for rel_path in REQUIRED_FILES:
        digest = parsed.get(rel_path)
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest.lower()):
            raise ValueError(f"Invalid SHA-256 digest for {rel_path}")
        normalized[rel_path] = digest.lower()
    return normalized


def read_pinned_sources(source_root_arg, expected_digests):
    raw_root = Path(source_root_arg)
    if raw_root.is_symlink() or not raw_root.is_dir():
        raise ValueError("Hermes source root must be a regular non-symlink directory")
    root_path = raw_root.resolve(strict=True)
    verified_texts = {}
    actual_digests = {}
    for rel_path in REQUIRED_FILES:
        candidate = raw_root / rel_path
        parent = raw_root
        for part in Path(rel_path).parts[:-1]:
            parent = parent / part
            if parent.is_symlink() or not parent.is_dir():
                raise ValueError(f"Intermediate directory for {rel_path} must be a non-symlink directory")
        if candidate.is_symlink():
            raise ValueError(f"Symlink source file rejected: {rel_path}")
        resolved = candidate.resolve(strict=True)
        if os.path.commonpath([str(root_path), str(resolved)]) != str(root_path):
            raise ValueError(f"Source file escapes root: {rel_path}")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(resolved, flags)
        try:
            st = os.fstat(fd)
            if not os.path.samestat(st, candidate.stat(follow_symlinks=False)):
                raise ValueError(f"File identity changed during open: {rel_path}")
            if st.st_size > MAX_SOURCE_BYTES:
                raise ValueError(f"Source file exceeds size cap: {rel_path}")
            chunks = []
            remaining = MAX_SOURCE_BYTES + 1
            while remaining > 0:
                chunk = os.read(fd, min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            raw_bytes = b"".join(chunks)
        finally:
            os.close(fd)
        if len(raw_bytes) > MAX_SOURCE_BYTES:
            raise ValueError(f"Source file exceeds size cap: {rel_path}")
        digest = hashlib.sha256(raw_bytes).hexdigest()
        if digest != expected_digests[rel_path]:
            raise ValueError(f"SHA-256 mismatch for {rel_path}: expected {expected_digests[rel_path]}, got {digest}")
        actual_digests[rel_path] = digest
        verified_texts[rel_path] = raw_bytes.decode("utf-8")
    return root_path, verified_texts, actual_digests


def verify_stdlib_only_replay(tree):
    stdlib_names = set(sys.stdlib_module_names)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                top = alias.name.split(".", 1)[0]
                if top not in stdlib_names:
                    raise ValueError(f"Non-stdlib import rejected in event_replay.py: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            if node.level != 0 or not node.module:
                raise ValueError("Relative import rejected in event_replay.py")
            top = node.module.split(".", 1)[0]
            if top not in stdlib_names:
                raise ValueError(f"Non-stdlib from-import rejected in event_replay.py: {node.module}")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in DISALLOWED_CALL_NAMES:
                raise ValueError(f"Disallowed dynamic builtin in event_replay.py: {node.func.id}")


def verify_restricted_ast(node, label, allowed_calls):
    for child in ast.walk(node):
        if isinstance(child, (ast.Import, ast.ImportFrom)):
            raise ValueError(f"Import rejected in {label}")
        if isinstance(child, ast.Call):
            if isinstance(child.func, ast.Name):
                if child.func.id in DISALLOWED_CALL_NAMES or child.func.id not in allowed_calls:
                    raise ValueError(f"Disallowed call {child.func.id} in {label}")
            elif isinstance(child.func, ast.Attribute):
                if not (isinstance(child.func.value, ast.Name) and child.func.value.id == "_contracts"
                        and child.func.attr == "check_payload"):
                    raise ValueError(f"Disallowed attribute call in {label}")
            else:
                raise ValueError(f"Disallowed dynamic call expression in {label}")


args = parse_args(sys.argv[1:])
expected_sha256 = load_expected_digests(args.expected_sha256)
root, verified_sources, verified_digests = read_pinned_sources(args.source_root, expected_sha256)
replay_source = verified_sources["tui_gateway/event_replay.py"]
server_source = verified_sources["tui_gateway/server.py"]
entry_source = verified_sources["tui_gateway/entry.py"]

replay_ast = ast.parse(replay_source, filename="tui_gateway/event_replay.py")
verify_stdlib_only_replay(replay_ast)
replay_code = compile(replay_ast, str(root / "tui_gateway/event_replay.py"), "exec")


def load_replay(name):
    spec = importlib.util.spec_from_loader(name, loader=None, origin=str(root / "tui_gateway/event_replay.py"))
    module = importlib.util.module_from_spec(spec)
    exec(replay_code, module.__dict__)
    return module


constructor = next(node for node in ast.parse(server_source, filename="tui_gateway/server.py").body
                   if isinstance(node, ast.FunctionDef) and node.name == "_event_frame")
verify_restricted_ast(constructor, "server.py:_event_frame", {"dict", "isinstance", "len", "str"})
namespace = {"_contracts": SimpleNamespace(check_payload=lambda *_: None)}
exec(compile(ast.Module(body=[constructor], type_ignores=[]), str(root / "tui_gateway/server.py"), "exec"), namespace)
make_frame = namespace["_event_frame"]
replay = load_replay("hermes_contract_poc")

# Reuse the actual startup frame literal without running entry.py's bootstrap.
ready_ast = next(node for node in ast.walk(ast.parse(entry_source, filename="tui_gateway/entry.py"))
                 if isinstance(node, ast.Dict) and any(
                     isinstance(child, ast.Constant) and child.value == "gateway.ready"
                     for child in node.values))
verify_restricted_ast(ready_ast, "entry.py:gateway.ready", {"resolve_skin", "replay_epoch"})
# ready_ast is the nested params dict, whose skin is irrelevant to this POC.
ready_params = eval(compile(ast.Expression(ready_ast), str(root / "tui_gateway/entry.py"), "eval"), {
    "__builtins__": {},
    "resolve_skin": lambda: {}, "replay_epoch": replay.replay_epoch,
})
ready = {"jsonrpc": "2.0", "method": "event", "params": ready_params}
replay._stamp_event(ready)
assert "session_id" not in ready["params"] and "seq" not in ready["params"]
checks = ["actual startup params are global and unsequenced"]

frames = [ready]
for event, payload in [("message.start", None), ("message.delta", {"text": "你好"}),
                       ("message.complete", {"text": "ok", "status": "complete"})]:
    frame = make_frame(event, "poc-session", payload)
    replay._stamp_event(frame)
    frames.append(frame)
assert "payload" not in frames[1]["params"]
assert frames[2]["params"]["payload"]["text"] == "你好"
assert [f["params"]["seq"] for f in frames[1:]] == [1, 2, 3]
checks.append("actual event constructor uses payload and session sequences")
assert replay.events_since("poc-session", 1) == [f["params"] for f in frames[2:]]
checks.append("replay contains params not JSON-RPC frames")
assert replay.events_since("other-session", 0) == []
checks.append("session isolation")

for _ in range(520):
    replay._stamp_event(make_frame("message.delta", "ring", {"text": "x"}))
assert len(replay.events_since("ring", 0)) == 512
assert replay.is_truncated("ring", 0) and not replay.is_truncated("ring", 8)
checks.append("ring eviction reports truncation")
replay._stamp_event(make_frame("tool.complete", "ring", {"text": "x" * (4 * 1024 * 1024 + 1)}))
assert replay.latest_seq("ring") == 521 and replay.is_truncated("ring", 520)
checks.append("oversized event leaves a detectable gap")
restarted = load_replay("hermes_contract_poc_restart")
assert restarted.replay_epoch() != replay.replay_epoch()
assert restarted.latest_seq("poc-session") == 0
checks.append("restart has new epoch and no persistent replay")

epoch = replay.replay_epoch()
for i in range(65):
    replay._stamp_event(make_frame("message.start", "evict-" + str(i)))
assert replay.latest_seq("poc-session") == 0
replay._stamp_event(make_frame("message.delta", "poc-session", {"text": "after eviction"}))
assert replay.replay_epoch() == epoch and replay.latest_seq("poc-session") == 1
assert not replay.is_truncated("poc-session", 3)
assert replay.events_since("poc-session", 3) == []
checks.append("same-epoch session eviction resets seq without truncation: snapshot required")

if args.wire:
    for frame in frames:
        print(json.dumps(frame, ensure_ascii=False))
else:
    print(json.dumps({
        "kind": "isolated-upstream-contract-not-backend-e2e",
        "checks": checks,
        "source_sha256": verified_digests,
    }, indent=2))
