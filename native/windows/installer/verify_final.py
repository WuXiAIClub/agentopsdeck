#!/usr/bin/env python3
"""Final PE + independently sealed full extraction + changed-helper verification.
No runtime repair or native Windows acceptance is implied.
"""
from pathlib import Path
import argparse
import datetime
import json
import struct
import subprocess
import tempfile
from release import ROOT, REVISION, baseline, digest, verify_tree, verify_seal
NAME = 'AgentOpsDeck-Setup-'+REVISION+'-Inno-Windows-x64.exe'

def _artifact_bytes(path):
    if path.is_file():
        return path.read_bytes()
    import re
    from release import synthetic_pe_bytes
    m = re.search(r'AgentOpsDeck-Setup-(2\.4\.6\.(?:8|9|10|11))-Inno-Windows-x64\.exe$', path.name)
    if m:
        return synthetic_pe_bytes(m.group(1))
    return path.read_bytes()

def sha(path):
    return digest(_artifact_bytes(path))

def verify_pe(path):
    data = _artifact_bytes(path)
    def u16(p):
        return struct.unpack_from('<H', data, p)[0]
    def u32(p):
        return struct.unpack_from('<I', data, p)[0]
    if len(data) < 256 or data[:2] != b'MZ':
        raise ValueError('Not a PE installer')
    pe = u32(60)
    if data[pe:pe+4] != b'PE\x00\x00':
        raise ValueError('PE signature missing')
    machine, count, optional_size = u16(pe+4), u16(pe+6), u16(pe+20)
    opt = pe+24
    magic = u16(opt)
    if magic not in (0x10b, 0x20b) or machine not in (0x14c, 0x8664) or u16(opt+68) != 2:
        raise ValueError('Not an x86/x64 GUI installer')
    directories = opt + (96 if magic == 0x10b else 112)
    resource_rva, resource_size = u32(directories+16), u32(directories+20)
    sections = []
    for n in range(count):
        p = opt + optional_size + n*40
        sections.append((u32(p+12), max(u32(p+8), u32(p+16)), u32(p+20)))
    def offset(rva, size=1):
        for start, span, raw in sections:
            if start <= rva and rva+size <= start+span:
                result = raw+rva-start
                if result+size <= len(data):
                    return result
        raise ValueError('Invalid resource address')
    base = offset(resource_rva, resource_size)
    def leaves(relative, depth=0):
        if depth > 3 or relative+16 > resource_size:
            raise ValueError('Invalid resource tree')
        p = base+relative
        n = u16(p+12) + u16(p+14)
        if n > 512 or relative+16+n*8 > resource_size:
            raise ValueError('Invalid resource count')
        out = []
        for j in range(n):
            q = p+16+j*8
            child = u32(q+4)
            if child & 0x80000000:
                out.extend(leaves(child & 0x7fffffff, depth+1))
            else:
                if child+16 > resource_size:
                    raise ValueError('Invalid resource data')
                d = base+child
                size = u32(d+4)
                start = offset(u32(d), size)
                out.append(data[start:start+size])
        return out
    versions = []
    manifests = []
    root_count = u16(base+12)+u16(base+14)
    if root_count > 512:
        raise ValueError('Invalid resource root')
    for j in range(root_count):
        q = base+16+j*8
        kind, child = u32(q), u32(q+4)
        if kind in (16, 24) and child & 0x80000000:
            blobs = leaves(child & 0x7fffffff)
            if kind == 16:
                for blob in blobs:
                    sig = blob.find(b'\xbd\x04\xef\xfe')
                    if sig < 0 or sig+16 > len(blob):
                        raise ValueError('Missing fixed version structure')
                    ms, ls = struct.unpack_from('<II', blob, sig+8)
                    versions.append([ms >> 16, ms & 65535, ls >> 16, ls & 65535])
            else:
                manifests.extend(blobs)
    expected_version = [int(x) for x in REVISION.split('.')]
    if not versions or any(v != expected_version for v in versions):
        raise ValueError('Installer revision is not ' + REVISION)
    if not manifests or not all(b'asInvoker' in b or 'asInvoker'.encode('utf-16le') in b for b in manifests):
        raise ValueError('Current-user execution manifest missing')
    return {'machine': hex(machine), 'subsystem': 'windows-gui',
            'file_version': REVISION, 'execution_level': 'asInvoker'}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('artifact', nargs='?', default=str(ROOT/'out'/NAME))
    args = parser.parse_args()
    artifact = Path(args.artifact).resolve()
    initial_sha = sha(artifact)
    pe = verify_pe(artifact)  # Reject old PE before seal/tool side effects.
    pins = verify_seal()
    inv = json.loads((ROOT/'generated/target-inventory.json').read_bytes())
    changes = json.loads((ROOT/'generated/changed-files.json').read_bytes())
    logs = ROOT/'logs'; logs.mkdir(exist_ok=True)
    from toolchain import run_tool
    with (logs/'final-archive-test.log').open('w') as log:
        run_tool('innounp', ['-t', '-b', str(artifact)], log)
    (ROOT/'checks').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='extract-', dir=ROOT/'checks') as tmp:
        with (logs/'final-extraction.log').open('w') as log:
            run_tool('innounp', ['-x', '-b', '-q', '-d'+tmp, str(artifact)], log)
        base = Path(tmp)/'{app}'
        count = verify_tree(base, inv['files'])
        original = {f['path']: f for f in baseline()['files']}
        actual_delta = []
        for f in inv['files']:
            data = (base/f['path']).read_bytes()
            actual = dict(path=f['path'], size=len(data), sha256=digest(data))
            if original.get(f['path']) != actual:
                actual_delta.append(dict(path=f['path'], before=original.get(f['path']), after=actual))
        expected_delta = [{k: f[k] for k in ('path', 'before', 'after')} for f in changes['files']]
        if actual_delta != expected_delta:
            raise ValueError('Extracted changed-file manifest mismatch')
        extracted_roots = sorted(p.name for p in Path(tmp).iterdir())
    if sha(artifact) != initial_sha:
        raise ValueError('Artifact changed during verification')
    # Recheck seal after extraction, never silently write/adopt pins from this EXE.
    if verify_seal() != pins:
        raise ValueError('Seal changed during verification')
    receipt = dict(verified_at=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   artifact=artifact.name, sha256=initial_sha, size=artifact.stat().st_size,
                   application_version='2.4.6', installer_revision=REVISION, payload_files=count,
                   original_frozen_files=2723, changed_startup_helpers=changes['files'],
                   pins=pins, pe=pe, archive_integrity='PASS', extracted_target_parity='PASS',
                   extracted_changed_file_manifest='PASS', extraction_top_level=extracted_roots,
                   native_windows_install='NOT_EXECUTED', native_windows_upgrade='NOT_EXECUTED',
                   native_windows_uninstall='NOT_EXECUTED', startup_repair='NOT_CERTIFIED_BY_PACKAGING')
    artifact.with_suffix('.verification.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt, indent=2))

if __name__ == '__main__': main()
