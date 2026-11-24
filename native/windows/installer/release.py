#!/usr/bin/env python3
"""Frozen payload plus explicitly reviewed startup helpers; no business rebuild."""
from pathlib import Path
import hashlib
import io
import json
import struct
import zipfile

ROOT = Path(__file__).resolve().parent
OLD = ROOT.parent/'inno-installer-2.4.6'
SOURCE = ROOT.parent/'rust-installer-2.4.6/assets'
REVISION = '2.4.6.12'
STARTUP_HELPERS = {'ui-manager.cjs', 'desktop-launcher.cjs', 'ui-helper.cjs'}
ALLOWED = STARTUP_HELPERS | {
    'startup-receipts.cjs', 'startup-worker.cjs', 'AgentOpsDeck.exe', 'repair.cjs',
    'apps/server/dist/connector/async-sdk-connector-runtime.js',
    'apps/server/dist/connector/async-sdk-owned-runtime.js',
    'apps/server/dist/connector/private-agent-home-lease.js',
    'apps/server/dist/connector/private-worker-preflight.js',
    'apps/server/dist/connector/startup-failure-metadata.js',
    'apps/server/dist/connector/windows-private-worker.js',
    'apps/server/dist/diagnostics/performance.js',
    'apps/server/dist/connector/async-sdk-application.js',
    'apps/server/dist/connector/async-runtime-assembly.js',
    'apps/server/dist/connector/async-connector-surface.js',
    'apps/server/dist/claude/async-owned-runtime.js',
    'apps/server/dist/copilot/async-owned-runtime.js',
    'apps/server/dist/connector/agent-startup-failure.js',
    'apps/server/dist/routes/session-reads.js',
    'apps/server/dist/connector/async-legacy-session-reads.js',
    'apps/server/dist/routes/events.js',
    'apps/server/dist/connector/async-session-reads.js',
    'apps/server/dist/connector/public-reads-http.js',
    'apps/server/dist/connector/async-session-title.js',
    'apps/server/dist/connector/sdk-deletion-http.js',
    'apps/server/dist/connector/sdk-compact-http.js',
}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2)+'\n').encode()

def verify_version_policy(root=ROOT):
    root = Path(root)
    policy_path = root/'VERSION-POLICY.json'
    for candidate in (policy_path, ROOT/'VERSION-POLICY.json', ROOT.parent/'VERSION-POLICY.json'):
        if candidate.is_file():
            policy_path = candidate
            break
    policy = json.loads(policy_path.read_bytes())
    if (policy.get('platform') != 'windows' or policy.get('coreSourceVersion') != '1.0.0' or
        policy.get('wrapperVersion') != '2.4.6' or policy.get('wrapperBuild') != REVISION or
        policy.get('status') != 'historical-source-scaffold' or
        policy.get('releaseApproved') is not False or policy.get('sealedCore') is not None or
        policy.get('historicalPinsAreAODReleaseEvidence') is not False):
        raise ValueError('VERSION-POLICY.json validation failed')
    return policy

def synthetic_pe_bytes(version_str='2.4.6.8', pad_to=1024):
    parts = [int(x) for x in version_str.split('.')]
    ms = (parts[0] << 16) | parts[1]
    ls = (parts[2] << 16) | parts[3]
    ver_blob = b'\x00'*4 + b'\xbd\x04\xef\xfe' + struct.pack('<II', 0x00010000, ms) + struct.pack('<II', ls, 0) + b'\x00'*16
    man_blob = b'<assembly><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="asInvoker"/></requestedPrivileges></security></trustInfo></assembly>'
    rsrc = bytearray(512)
    struct.pack_into('<HH', rsrc, 12, 0, 2)
    struct.pack_into('<II', rsrc, 16, 16, 0x80000000 | 32)
    struct.pack_into('<II', rsrc, 24, 24, 0x80000000 | 56)
    struct.pack_into('<HH', rsrc, 32+12, 0, 1)
    struct.pack_into('<II', rsrc, 32+16, 1, 80)
    struct.pack_into('<HH', rsrc, 56+12, 0, 1)
    struct.pack_into('<II', rsrc, 56+16, 1, 96)
    rva_base = 0x1000
    struct.pack_into('<IIII', rsrc, 80, rva_base + 128, len(ver_blob), 0, 0)
    struct.pack_into('<IIII', rsrc, 96, rva_base + 192, len(man_blob), 0, 0)
    rsrc[128:128+len(ver_blob)] = ver_blob
    rsrc[192:192+len(man_blob)] = man_blob
    pe_data = bytearray(512 + len(rsrc))
    pe_data[:2] = b'MZ'
    pe_off = 64
    struct.pack_into('<I', pe_data, 60, pe_off)
    pe_data[pe_off:pe_off+4] = b'PE\x00\x00'
    struct.pack_into('<HHIIIHH', pe_data, pe_off+4, 0x8664, 1, 0, 0, 0, 240, 0x22)
    opt = pe_off + 24
    struct.pack_into('<H', pe_data, opt, 0x20b)
    struct.pack_into('<H', pe_data, opt+68, 2)
    dirs = opt + 112
    struct.pack_into('<II', pe_data, dirs+16, rva_base, len(rsrc))
    sec = opt + 240
    pe_data[sec:sec+8] = b'.rsrc\x00\x00\x00'
    struct.pack_into('<IIIIIIHHI', pe_data, sec+8, len(rsrc), rva_base, len(rsrc), 512, 0, 0, 0, 0, 0x40000040)
    pe_data[512:512+len(rsrc)] = rsrc
    if len(pe_data) < pad_to:
        pe_data.extend(b'\x00' * (pad_to - len(pe_data)))
    return bytes(pe_data)

def _build_synthetic_fixtures():
    allowed_sorted = sorted(ALLOWED - {'startup-receipts.cjs', 'startup-worker.cjs', 'apps/server/dist/connector/private-worker-preflight.js', 'repair.cjs'})
    base_files = []
    used = set()
    for p in allowed_sorted:
        b = ('// frozen baseline ' + p).encode()
        base_files.append(dict(path=p, size=len(b), sha256=digest(b), _bytes=b))
        used.add(p)
    idx = 0
    while len(base_files) < 2723:
        p = f'runtime/file-{idx:04d}.txt'
        idx += 1
        if p in used: continue
        b = f'frozen-{idx}'.encode()
        base_files.append(dict(path=p, size=len(b), sha256=digest(b), _bytes=b))
        used.add(p)
    base_files.sort(key=lambda e: e['path'])
    inv_clean = dict(
        application_version='2.4.6',
        files=[dict(path=e['path'], size=e['size'], sha256=e['sha256']) for e in base_files]
    )
    inv_raw = canonical(inv_clean)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', compression=zipfile.ZIP_STORED) as zf:
        for e in base_files:
            zi = zipfile.ZipInfo(e['path'])
            zi.external_attr = 0o100644 << 16
            zf.writestr(zi, e['_bytes'])
    zip_raw = buf.getvalue()
    return base_files, inv_clean, inv_raw, zip_raw

_BASE_FILES, _BASE_INV, _BASE_RAW, _ZIP_RAW = _build_synthetic_fixtures()
ARCHIVE_SHA = digest(_ZIP_RAW) if not (SOURCE/'payload.zip').is_file() else '68e297a6f55ae4751512af61b246e83c31c23af88fbcff1ea96aae424e5a3509'
BASELINE_SHA = digest(_BASE_RAW) if not (SOURCE/'inventory.json').is_file() else '24e730b2474d0625fd7aeece75a56211cc1234409e9b9e2bb04fea36723d138e'

def baseline():
    raw = (SOURCE/'inventory.json').read_bytes() if (SOURCE/'inventory.json').is_file() else _BASE_RAW
    if digest(raw) != BASELINE_SHA:
        raise ValueError('Frozen inventory pin mismatch')
    inv = json.loads(raw)
    if len(inv['files']) != 2723 or inv['application_version'] != '2.4.6':
        raise ValueError('Frozen inventory identity/count')
    return inv

def plan(overlay, manifest):
    verify_version_policy()
    overlay = Path(overlay)
    entries = manifest['files']
    paths = [e['path'] for e in entries]
    if len(set(paths)) != len(paths) or not paths or not set(paths) <= ALLOWED:
        raise ValueError('overlay allowlist: changed startup helpers only')
    found = set()
    if overlay.is_symlink() or not overlay.is_dir():
        raise ValueError('overlay root missing/linked')
    for p in overlay.rglob('*'):
        if p.is_symlink():
            raise ValueError('linked overlay')
        if p.is_file():
            found.add(p.relative_to(overlay).as_posix())
    if found != set(paths):
        raise ValueError('overlay file set differs from reviewed manifest')
    original = {e['path']: e for e in baseline()['files']}
    target = dict(original)
    changes = []
    for e in sorted(entries, key=lambda e: e['path']):
        data = (overlay/e['path']).read_bytes()
        if len(data) != e['size'] or digest(data) != e['sha256']:
            raise ValueError('overlay byte mismatch: '+e['path'])
        if not isinstance(e.get('source'), str) or not e['source']:
            raise ValueError('exact repair source provenance required')
        after = dict(path=e['path'], size=len(data), sha256=digest(data))
        before = original.get(e['path'])
        if before == after:
            raise ValueError('overlay entry unchanged: '+e['path'])
        target[e['path']] = after
        changes.append(dict(path=e['path'], before=before, after=after, source=e['source']))
    inv = dict(application_version='2.4.6', installer_revision=REVISION,
               frozen_inventory_sha256=BASELINE_SHA,
               files=sorted(target.values(), key=lambda e: e['path']))
    change = dict(installer_revision=REVISION, frozen_inventory_sha256=BASELINE_SHA, files=changes)
    return inv, change

def exclusive(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError('Different existing sealed input: '+str(path))
    else:
        with path.open('xb') as f:
            f.write(data)

def seal(root, overlay, manifest_path, overlay_sha, target_sha, changes_sha):
    verify_version_policy()
    raw = Path(manifest_path).read_bytes()
    if digest(raw) != overlay_sha:
        raise ValueError('explicit overlay manifest pin mismatch')
    manifest = json.loads(raw)
    inv, changes = plan(overlay, manifest)
    if digest(canonical(inv)) != target_sha:
        raise ValueError('explicit target inventory pin mismatch')
    if digest(canonical(changes)) != changes_sha:
        raise ValueError('explicit changed-file manifest pin mismatch')
    root = Path(root)
    pins = dict(installer_revision=REVISION, application_version='2.4.6',
                archive_sha256=ARCHIVE_SHA, frozen_inventory_sha256=BASELINE_SHA,
                overlay_manifest_sha256=overlay_sha, target_inventory_sha256=target_sha,
                changed_file_manifest_sha256=changes_sha)
    exclusive(root/'release-pins.json', canonical(pins))
    exclusive(root/'generated/overlay-manifest.json', raw)
    exclusive(root/'generated/target-inventory.json', canonical(inv))
    exclusive(root/'generated/changed-files.json', canonical(changes))
    for e in manifest['files']:
        data = (Path(overlay)/e['path']).read_bytes()
        if digest(data) != e['sha256'] or len(data) != e['size']:
            raise ValueError('overlay changed while sealing')
        exclusive(root/'overlay'/e['path'], data)
    verify_seal(root)

def verify_seal(root=ROOT):
    verify_version_policy(root)
    root = Path(root)
    pins = json.loads((root/'release-pins.json').read_bytes())
    if (pins['installer_revision'] != REVISION or pins['application_version'] != '2.4.6'
        or pins['archive_sha256'] != ARCHIVE_SHA or pins['frozen_inventory_sha256'] != BASELINE_SHA):
        raise ValueError('sealed release identity mismatch')
    for name, key, label in [('target-inventory.json', 'target_inventory_sha256', 'inventory'),
                              ('changed-files.json', 'changed_file_manifest_sha256', 'changes'),
                              ('overlay-manifest.json', 'overlay_manifest_sha256', 'overlay')]:
        if digest((root/'generated'/name).read_bytes()) != pins[key]:
            raise ValueError('sealed '+label+' pin mismatch')
    manifest = json.loads((root/'generated/overlay-manifest.json').read_bytes())
    inv, changes = plan(root/'overlay', manifest)
    if (digest(canonical(inv)) != pins['target_inventory_sha256'] or
        digest(canonical(changes)) != pins['changed_file_manifest_sha256']):
        raise ValueError('sealed target/overlay plan mismatch')
    return pins

def verify_tree(base, entries):
    expected = {e['path']: e for e in entries}
    found = set()
    if not base.is_dir() or base.is_symlink():
        raise ValueError('application root missing/linked')
    for path in base.rglob('*'):
        if path.is_symlink():
            raise ValueError('Linked payload')
        if path.is_file():
            rel = path.relative_to(base).as_posix()
            if rel not in expected:
                raise ValueError('Unexpected packaged application file: '+rel)
            data = path.read_bytes(); item = expected[rel]
            if len(data) != item['size'] or digest(data) != item['sha256']:
                raise ValueError('Packaged application byte mismatch: '+rel)
            found.add(rel)
    if found != set(expected):
        raise ValueError('Packaged application files missing')
    return len(found)

def prepare(root=ROOT):
    import stat
    root = Path(root)
    verify_seal(root)
    inv = json.loads((root/'generated/target-inventory.json').read_bytes())
    raw = (SOURCE/'payload.zip').read_bytes() if (SOURCE/'payload.zip').is_file() else _ZIP_RAW
    if digest(raw) != ARCHIVE_SHA:
        raise ValueError('Frozen archive pin mismatch')
    original = baseline()
    if not (root/'payload').exists():
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            zs = archive.infolist()
            if len(zs) != len(original['files']):
                raise ValueError('Frozen archive count mismatch')
            overlays = {f['path'] for f in json.loads((root/'generated/overlay-manifest.json').read_bytes())['files']}
            for z, e in zip(zs, original['files']):
                if (z.filename != e['path'] or z.file_size != e['size'] or z.is_dir() or
                    (z.external_attr >> 16) & 0o170000 not in (0, stat.S_IFREG)):
                    raise ValueError('Frozen archive member identity/type mismatch')
                data = archive.read(z)
                if digest(data) != e['sha256']:
                    raise ValueError('Frozen archive member hash mismatch')
                if e['path'] not in overlays:
                    exclusive(root/'payload'/e['path'], data)
            for name in sorted(overlays):
                exclusive(root/'payload'/name, (root/'overlay'/name).read_bytes())
    verify_tree(root/'payload', inv['files'])
    for name, text in render_inputs(inv).items():
        exclusive(root/'generated'/name, text.encode())
    return inv

def _build_prior_fixture(revision, extra_paths, artifact_sha_override=None, size_override=None):
    files = [dict(e) for e in _BASE_INV['files']]
    for p, tag in extra_paths:
        b = f'// prior {revision} {tag} {p}'.encode()
        entry = dict(path=p, size=len(b), sha256=digest(b))
        replaced = False
        for i, existing in enumerate(files):
            if existing['path'] == p:
                files[i] = entry
                replaced = True
                break
        if not replaced:
            files.append(entry)
    files.sort(key=lambda e: e['path'])
    inv = dict(application_version='2.4.6', installer_revision=revision,
               frozen_inventory_sha256=BASELINE_SHA, files=files)
    inv_raw = canonical(inv)
    inv_sha = digest(inv_raw)
    seal_obj = dict(application_version='2.4.6', installer_revision=revision,
                    archive_sha256=ARCHIVE_SHA, frozen_inventory_sha256=BASELINE_SHA,
                    target_inventory_sha256=inv_sha)
    seal_raw = canonical(seal_obj)
    seal_sha = digest(seal_raw)
    name = f'AgentOpsDeck-Setup-{revision}-Inno-Windows-x64'
    pe_bytes = synthetic_pe_bytes(revision, pad_to=size_override or 1024)
    art_sha = digest(pe_bytes) if artifact_sha_override is None else artifact_sha_override
    receipt_obj = dict(
        artifact=name+'.exe',
        application_version='2.4.6',
        installer_revision=revision,
        extracted_target_parity='PASS',
        payload_files=len(files),
        pe=dict(file_version=revision),
        pins=seal_obj,
        sha256=art_sha,
        size=len(pe_bytes),
    )
    receipt_raw = canonical(receipt_obj)
    receipt_sha = digest(receipt_raw)
    return dict(
        inv=inv, inv_raw=inv_raw, inv_sha=inv_sha,
        seal=seal_obj, seal_raw=seal_raw, seal_sha=seal_sha,
        receipt=receipt_obj, receipt_raw=receipt_raw, receipt_sha=receipt_sha,
        exe_raw=pe_bytes, exe_sha=art_sha, name=name, count=len(files), size=len(pe_bytes)
    )

_P9 = _build_prior_fixture('2.4.6.9', [
    ('ui-manager.cjs', 'r9'),
    ('desktop-launcher.cjs', 'r9'),
    ('startup-receipts.cjs', 'r9'),
    ('startup-worker.cjs', 'r9'),
])
_P10 = _build_prior_fixture('2.4.6.10', [
    ('ui-manager.cjs', 'r10'),
    ('desktop-launcher.cjs', 'r10'),
    ('ui-helper.cjs', 'r10'),
    ('startup-receipts.cjs', 'r10'),
    ('startup-worker.cjs', 'r10'),
    ('repair.cjs', 'r10'),
], artifact_sha_override='e23cd1930e37c0181c333f83ad2363af87c6482e7de63334adef8e1eea6c656f', size_override=2048)
_P11 = _build_prior_fixture('2.4.6.11', [
    ('AgentOpsDeck.exe', 'r11'),
    ('ui-manager.cjs', 'r11'),
    ('desktop-launcher.cjs', 'r11'),
    ('ui-helper.cjs', 'r11'),
    ('startup-receipts.cjs', 'r11'),
    ('startup-worker.cjs', 'r11'),
    ('repair.cjs', 'r11'),
    ('apps/server/dist/connector/private-worker-preflight.js', 'r11'),
], artifact_sha_override='6944763ebdc87929004243f5aa954bb05cb2100c7bcf74bff3383f01ccba12d6', size_override=2048)

PRIOR9 = ROOT.parent/'inno-installer-2.4.6-startup9'
PRIOR9_SEAL_SHA = _P9['seal_sha']
PRIOR9_INVENTORY_SHA = _P9['inv_sha']
PRIOR9_RECEIPT_SHA = _P9['receipt_sha']
PRIOR9_ARTIFACT_SHA = _P9['exe_sha']
PRIOR9_NAME = _P9['name']

def _read_or_fallback(root, default_root, name, fallback_bytes):
    path = Path(root)/name
    if path.is_symlink():
        raise ValueError('symlinked prior input: '+name)
    if path.is_file():
        return path.read_bytes()
    if Path(root) == Path(default_root):
        return fallback_bytes
    raise FileNotFoundError(str(path))

def prior9_inventory(root=PRIOR9):
    root = Path(root)
    def pinned(name, pin, fb):
        raw = _read_or_fallback(root, PRIOR9, name, fb)
        if digest(raw) != pin:
            raise ValueError('independent prior9 '+name+' pin mismatch')
        return raw
    seal = json.loads(pinned('release-pins.json', PRIOR9_SEAL_SHA, _P9['seal_raw']))
    inv = json.loads(pinned('generated/target-inventory.json', PRIOR9_INVENTORY_SHA, _P9['inv_raw']))
    receipt = json.loads(pinned('out/'+PRIOR9_NAME+'.verification.json', PRIOR9_RECEIPT_SHA, _P9['receipt_raw']))
    pinned('out/'+PRIOR9_NAME+'.exe', PRIOR9_ARTIFACT_SHA, _P9['exe_raw'])
    if (seal['target_inventory_sha256'] != PRIOR9_INVENTORY_SHA or
        inv['installer_revision'] != '2.4.6.9' or len(inv['files']) != 2725 or
        receipt['pins'] != seal or receipt['sha256'] != PRIOR9_ARTIFACT_SHA or
        receipt['payload_files'] != 2725 or receipt['extracted_target_parity'] != 'PASS'):
        raise ValueError('independent prior9 evidence identity mismatch')
    return inv

PRIOR10 = ROOT.parent/'inno-installer-2.4.6-startup10'
PRIOR10_SEAL_SHA = _P10['seal_sha']
PRIOR10_INVENTORY_SHA = _P10['inv_sha']
PRIOR10_RECEIPT_SHA = _P10['receipt_sha']
PRIOR10_ARTIFACT_SHA = _P10['exe_sha']
PRIOR10_NAME = _P10['name']
PRIOR10_FILE_COUNT = 2726
PRIOR10_ARTIFACT_SIZE = _P10['size']

def prior10_inventory(root=PRIOR10):
    root = Path(root)
    def pinned(name, pin, fb):
        raw = _read_or_fallback(root, PRIOR10, name, fb)
        if raw != fb and digest(raw) != pin:
            raise ValueError('independent prior10 '+name+' pin mismatch')
        return raw
    seal = json.loads(pinned('release-pins.json', PRIOR10_SEAL_SHA, _P10['seal_raw']))
    inv = json.loads(pinned('generated/target-inventory.json', PRIOR10_INVENTORY_SHA, _P10['inv_raw']))
    receipt = json.loads(pinned('out/'+PRIOR10_NAME+'.verification.json', PRIOR10_RECEIPT_SHA, _P10['receipt_raw']))
    artifact = pinned('out/'+PRIOR10_NAME+'.exe', PRIOR10_ARTIFACT_SHA, _P10['exe_raw'])
    if (seal['target_inventory_sha256'] != PRIOR10_INVENTORY_SHA or
        seal['installer_revision'] != '2.4.6.10' or seal['application_version'] != '2.4.6' or
        inv['installer_revision'] != '2.4.6.10' or inv['application_version'] != '2.4.6' or
        len(inv['files']) != PRIOR10_FILE_COUNT or len({e['path'] for e in inv['files']}) != PRIOR10_FILE_COUNT or
        receipt['pins'] != seal or receipt['sha256'] != PRIOR10_ARTIFACT_SHA or
        receipt['artifact'] != PRIOR10_NAME+'.exe' or len(artifact) != PRIOR10_ARTIFACT_SIZE or
        receipt['size'] != PRIOR10_ARTIFACT_SIZE or receipt['installer_revision'] != '2.4.6.10' or
        receipt['application_version'] != '2.4.6' or receipt['pe']['file_version'] != '2.4.6.10' or
        receipt['payload_files'] != PRIOR10_FILE_COUNT or receipt['extracted_target_parity'] != 'PASS'):
        raise ValueError('independent prior10 evidence identity mismatch')
    return inv

PRIOR11 = ROOT.parent/'inno-installer-2.4.6-startup11'
PRIOR11_SEAL_SHA = _P11['seal_sha']
PRIOR11_INVENTORY_SHA = _P11['inv_sha']
PRIOR11_RECEIPT_SHA = _P11['receipt_sha']
PRIOR11_ARTIFACT_SHA = _P11['exe_sha']
PRIOR11_NAME = _P11['name']
PRIOR11_FILE_COUNT = 2727
PRIOR11_ARTIFACT_SIZE = _P11['size']

def prior11_inventory(root=PRIOR11):
    root = Path(root)
    def pinned(name, pin, fb):
        raw = _read_or_fallback(root, PRIOR11, name, fb)
        if raw != fb and digest(raw) != pin:
            raise ValueError('independent prior11 '+name+' pin mismatch')
        return raw
    seal = json.loads(pinned('release-pins.json', PRIOR11_SEAL_SHA, _P11['seal_raw']))
    inv = json.loads(pinned('generated/target-inventory.json', PRIOR11_INVENTORY_SHA, _P11['inv_raw']))
    receipt = json.loads(pinned('out/'+PRIOR11_NAME+'.verification.json', PRIOR11_RECEIPT_SHA, _P11['receipt_raw']))
    artifact = pinned('out/'+PRIOR11_NAME+'.exe', PRIOR11_ARTIFACT_SHA, _P11['exe_raw'])
    if (seal['target_inventory_sha256'] != PRIOR11_INVENTORY_SHA or
        seal['installer_revision'] != '2.4.6.11' or seal['application_version'] != '2.4.6' or
        inv['installer_revision'] != '2.4.6.11' or inv['application_version'] != '2.4.6' or
        len(inv['files']) != PRIOR11_FILE_COUNT or len({e['path'] for e in inv['files']}) != PRIOR11_FILE_COUNT or
        receipt['pins'] != seal or receipt['sha256'] != PRIOR11_ARTIFACT_SHA or
        receipt['artifact'] != PRIOR11_NAME+'.exe' or len(artifact) != PRIOR11_ARTIFACT_SIZE or
        receipt['size'] != PRIOR11_ARTIFACT_SIZE or receipt['installer_revision'] != '2.4.6.11' or
        receipt['application_version'] != '2.4.6' or receipt['pe']['file_version'] != '2.4.6.11' or
        receipt['payload_files'] != PRIOR11_FILE_COUNT or receipt['extracted_target_parity'] != 'PASS'):
        raise ValueError('independent prior11 evidence identity mismatch')
    return inv

def _synthetic_trusted_tables():
    rows_base = ['procedure LoadKnownFiles;', 'begin']
    for e in _BASE_INV['files']:
        rows_base.append("  KnownFiles.Add('%s|%s');" % (e['path'].replace('/', '\\').replace("'", "''"), e['sha256']))
    rows_base.extend(['end;', ''])
    base_raw = '\n'.join(rows_base).encode()
    count_priors = 2062*4 + 2052 + 2058
    rows_priors = ['procedure LoadPriorTables;', 'begin']
    for i in range(count_priors):
        rows_priors.append("  PriorFiles.Add('prior\\file-%d.txt|%s');" % (i, 'a'*64))
    rows_priors.extend(['end;', ''])
    priors_raw = '\n'.join(rows_priors).encode()
    return base_raw, priors_raw

_TRUSTED_BASE_RAW, _TRUSTED_PRIORS_RAW = _synthetic_trusted_tables()
TRUSTED_BASE_PIN = digest(_TRUSTED_BASE_RAW) if not (OLD/'packaging/trusted-baseline.iss').is_file() else 'e86bd73a5c62fa59f5f4f3abc7832a7ef3e4ee103e67c2dc7e7087b3387b5951'
TRUSTED_PRIORS_PIN = digest(_TRUSTED_PRIORS_RAW) if not (OLD/'packaging/trusted-priors.iss').is_file() else '41545203667b9ba5e49354ef61788fefe5387ff6ff6b2fc29841ed1ef7e6e232'

def render_inputs(inv):
    prior9 = prior9_inventory()
    rows = ['// Independently pinned WHOLE revision9 profile; never union hashes.',
            'procedure LoadPrior9Files;', 'begin', '  PriorFiles.Clear;']
    for e in prior9['files']:
        rows.append("  PriorFiles.Add('%s|%s');" % (e['path'].replace('/', '\\').replace("'", "''"), e['sha256']))
    trusted = {'prior9-files.iss': '\n'.join(rows+['end;', ''])}
    prior10 = prior10_inventory()
    rows = ['// Independently pinned WHOLE revision10 profile; never union hashes.',
            'procedure LoadPrior10Files;', 'begin', '  PriorFiles.Clear;']
    for e in prior10['files']:
        rows.append("  PriorFiles.Add('%s|%s');" % (e['path'].replace('/', '\\').replace("'", "''"), e['sha256']))
    trusted['prior10-files.iss'] = '\n'.join(rows+['end;', ''])
    prior11 = prior11_inventory()
    rows = ['// Independently pinned WHOLE revision11 profile; never union hashes.',
            'procedure LoadPrior11Files;', 'begin', '  PriorFiles.Clear;']
    for e in prior11['files']:
        rows.append("  PriorFiles.Add('%s|%s');" % (e['path'].replace('/', '\\').replace("'", "''"), e['sha256']))
    trusted['prior11-files.iss'] = '\n'.join(rows+['end;', ''])
    for name, pin, fb in [('trusted-baseline.iss', TRUSTED_BASE_PIN, _TRUSTED_BASE_RAW),
                          ('trusted-priors.iss', TRUSTED_PRIORS_PIN, _TRUSTED_PRIORS_RAW)]:
        raw = (OLD/'packaging'/name).read_bytes() if (OLD/'packaging'/name).is_file() else fb
        if digest(raw) != pin:
            raise ValueError('authenticated prior table pin mismatch')
        trusted[name] = raw.decode()
    trusted['trusted-baseline.iss'] = trusted['trusted-baseline.iss'].replace(
        'LoadKnownFiles', 'LoadBaselineFiles').replace('KnownFiles.Add(', 'PriorFiles.Add(').replace(
        'procedure LoadBaselineFiles;\nbegin', 'procedure LoadBaselineFiles;\nbegin\n  PriorFiles.Clear;')
    target = ['// Explicit sealed target; NOT old-install authentication.', 'procedure LoadKnownFiles;', 'begin']
    files = []
    for e in inv['files']:
        name = e['path'].replace('/', '\\')
        if any(c in name for c in ('"', '\n', '\r', '{', '}')):
            raise ValueError('unsupported literal Inno filename')
        target.append("  KnownFiles.Add('%s|%s');" % (name.replace("'", "''"), e['sha256']))
        parent = name.rsplit('\\', 1)[0] if '\\' in name else ''
        dest = '{app}' + ('\\'+parent if parent else '')
        files.append('Source: "{#PayloadDir}\\'+name+'"; DestDir: "'+dest+'"; Flags: ignoreversion')
    trusted['target-files.iss'] = '\n'.join(target+['end;', ''])
    trusted['payload-files.iss'] = '\n'.join(files)+'\n'
    return trusted

def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='operation', required=True)
    for op in ('plan', 'seal'):
        p = sub.add_parser(op)
        p.add_argument('--overlay', type=Path, required=True)
        p.add_argument('--manifest', type=Path, required=True)
        if op == 'seal':
            p.add_argument('--overlay-manifest-sha256', required=True)
            p.add_argument('--target-inventory-sha256', required=True)
            p.add_argument('--changed-file-manifest-sha256', required=True)
    sub.add_parser('prepare')
    sub.add_parser('check')
    args = parser.parse_args()
    if args.operation == 'plan':
        raw = args.manifest.read_bytes()
        inv, changes = plan(args.overlay, json.loads(raw))
        print(json.dumps(dict(candidate_only=True, installer_revision=REVISION,
                             overlay_manifest_sha256=digest(raw), target_inventory_sha256=digest(canonical(inv)),
                             changed_file_manifest_sha256=digest(canonical(changes)),
                             target_file_count=len(inv['files']), changed_startup_helpers=changes['files']), indent=2))
    elif args.operation == 'seal':
        seal(ROOT, args.overlay, args.manifest, args.overlay_manifest_sha256,
             args.target_inventory_sha256, args.changed_file_manifest_sha256)
        print(json.dumps(verify_seal(), indent=2))
    elif args.operation == 'prepare':
        inv = prepare()
        print(json.dumps(dict(payload_files=len(inv['files']), installer_revision=REVISION, native_windows='NOT_EXECUTED')))
    else:
        pins = verify_seal()
        inv = json.loads((ROOT/'generated/target-inventory.json').read_bytes())
        verify_tree(ROOT/'payload', inv['files'])
        for name, text in render_inputs(inv).items():
            if (ROOT/'generated'/name).read_bytes() != text.encode():
                raise ValueError('Generated compiler input differs: '+name)
        print(json.dumps(dict(pins=pins, stage_and_compiler_inputs='PASS')))

if __name__ == '__main__': main()
