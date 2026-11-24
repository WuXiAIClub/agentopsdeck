"""Revision11 scaffold gates; synthetic bytes are test-only, never shipping inputs."""
import importlib.util
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent

class ScaffoldTests(unittest.TestCase):
    def test_revision_and_exact_diagnostic_shipping_scope(self):
        self.assertTrue((ROOT/'release.py').is_file(), 'revision11 scaffold missing')
        spec = importlib.util.spec_from_file_location('release11', ROOT/'release.py')
        m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        self.assertEqual(m.REVISION, '2.4.6.12')
        recipe = (ROOT/'packaging/AgentOpsDeck.iss').read_text()
        self.assertIn('VersionInfoVersion=2.4.6.12', recipe)
        self.assertIn('OutputBaseFilename=AgentOpsDeck-Setup-2.4.6.12-Inno-Windows-x64', recipe)
        self.assertIn('AppVersion=2.4.6\n', recipe)
        self.assertIn('installer 2.4.6.12-Inno', (ROOT/'packaging/lifecycle.iss').read_text())
        self.assertEqual(m.ALLOWED, {
            'ui-manager.cjs', 'desktop-launcher.cjs', 'ui-helper.cjs',
            'startup-worker.cjs', 'startup-receipts.cjs', 'AgentOpsDeck.exe', 'repair.cjs',
            'apps/server/dist/connector/async-sdk-connector-runtime.js',
            'apps/server/dist/connector/async-sdk-owned-runtime.js',
            'apps/server/dist/connector/private-agent-home-lease.js',
            'apps/server/dist/connector/private-worker-preflight.js',
            'apps/server/dist/connector/startup-failure-metadata.js',
            'apps/server/dist/connector/windows-private-worker.js',
            'apps/server/dist/diagnostics/performance.js'} | {
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
            'apps/server/dist/connector/sdk-compact-http.js'})

class Prior9Tests(unittest.TestCase):
    def test_prior9_is_independently_pinned_and_tampering_is_rejected(self):
        import release as m
        self.assertTrue(callable(getattr(m, 'prior9_inventory', None)), 'independent prior9 authentication missing')
        inv = m.prior9_inventory()
        self.assertEqual(len(inv['files']), 2725)
        self.assertEqual(inv['installer_revision'], '2.4.6.9')
        import tempfile, shutil
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            root = Path(td)
            p9_map = {'release-pins.json': m._P9['seal_raw'], 'generated/target-inventory.json': m._P9['inv_raw'], 'out/'+m.PRIOR9_NAME+'.verification.json': m._P9['receipt_raw'], 'out/'+m.PRIOR9_NAME+'.exe': m._P9['exe_raw']}
            for name, fb in p9_map.items():
                (root/name).parent.mkdir(parents=True, exist_ok=True)
                if (m.PRIOR9/name).is_file(): shutil.copyfile(m.PRIOR9/name, root/name)
                else: (root/name).write_bytes(fb)
            # Even replacing both inventory and its disk seal cannot self-authorize.
            (root/'generated/target-inventory.json').write_bytes(m.canonical(dict(files=[])))
            with self.assertRaisesRegex(ValueError, 'prior9.*inventory.*pin'):
                m.prior9_inventory(root)
            seal = __import__('json').loads((root/'release-pins.json').read_bytes())
            seal['target_inventory_sha256'] = m.digest((root/'generated/target-inventory.json').read_bytes())
            (root/'release-pins.json').write_bytes(m.canonical(seal))
            with self.assertRaisesRegex(ValueError, 'prior9.*pin'):
                m.prior9_inventory(root)

    def test_whole_profiles_remain_separate_and_stop_is_rechecked(self):
        import release as m
        inputs = m.render_inputs(m.baseline())
        self.assertTrue('prior9-files.iss' in inputs, 'prior9 compiler table missing')
        self.assertEqual(inputs['prior9-files.iss'].count('PriorFiles.Add('), 2725)
        self.assertIn('PriorFiles.Clear;', inputs['prior9-files.iss'])
        life = (ROOT/'packaging/lifecycle.iss').read_text()
        self.assertIn('if not MatchesPriorPayload then LoadPrior9Files;', life)
        self.assertIn('if not MatchesPriorPayload then LoadTargetAsPrior;', life)
        self.assertIn('StopOwnedApplication;\n      CheckPayload(True);', life)

class BoundaryRegressionTests(unittest.TestCase):
    def test_real_revision9_pe_is_rejected_before_seal_or_extraction(self):
        import subprocess, sys, release as m
        before = (ROOT/'tool-state').exists()
        result = subprocess.run([sys.executable, str(ROOT/'verify_final.py'),
            str(m.PRIOR9/'out'/ (m.PRIOR9_NAME+'.exe'))], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Installer revision is not 2.4.6.12', result.stderr)
        self.assertNotIn('FileNotFoundError', result.stderr)
        self.assertEqual((ROOT/'tool-state').exists(), before)

    def test_actual_compiler_tables_reject_partial_and_mixed_profiles(self):
        import release as m
        # Interpret the exact table rows and selection order emitted for Pascal.
        # This is NOT a native Windows execution claim.
        import re
        baseline = m.baseline(); target = __import__('copy').deepcopy(m.prior11_inventory())
        target['installer_revision'] = '2.4.6.12'
        for entry in target['files']:
            if entry['path'] in ('AgentOpsDeck.exe', 'ui-manager.cjs'):
                entry['sha256'] = 'f'*64
        for entry in target['files']:
            if entry['path'] == 'apps/server/dist/connector/private-worker-preflight.js':
                entry['sha256'] = 'e'*64
        tables = m.render_inputs(target)
        self.assertIn('prior10-files.iss', tables, 'independent whole prior10 table missing')
        def rows(name, variable):
            pairs = re.findall(variable+r".Add\('([^']+)\|([0-9a-f]{64})'\);", tables[name])
            return dict(pairs)
        profiles = [rows('trusted-baseline.iss', 'PriorFiles'), rows('prior9-files.iss', 'PriorFiles'),
                    rows('prior10-files.iss', 'PriorFiles'), rows('prior11-files.iss', 'PriorFiles'), rows('target-files.iss', 'KnownFiles')]
        self.assertIn('PriorFiles.Clear;', tables['prior10-files.iss'])
        self.assertIn('procedure LoadPrior10Files;', tables['prior10-files.iss'])
        self.assertEqual(list(map(len, profiles)), [2723, 2725, 2726, 2727, 2727])
        def admitted(actual):
            for profile in profiles:
                if all(actual.get(p) == h for p, h in profile.items()):
                    # CheckTargetCollisions rejects unknown target paths even when
                    # their bytes happen to equal the proposed target hash.
                    return not any(p in actual and p not in profile for p in profiles[-1])
            return False
        for profile in profiles:
            self.assertTrue(admitted(dict(profile)))
            partial = dict(profile); partial.pop(next(iter(profile)))
            self.assertFalse(admitted(partial))
        mixed89 = dict(profiles[0]); mixed89['ui-manager.cjs'] = profiles[1]['ui-manager.cjs']
        self.assertFalse(admitted(mixed89))
        different = [p for p in profiles[1] if p in profiles[2] and profiles[1][p] != profiles[2][p]]
        self.assertGreater(len(different), 1)
        mixed910 = dict(profiles[1]); mixed910[different[0]] = profiles[2][different[0]]
        self.assertFalse(admitted(mixed910))
        mixed109 = dict(profiles[2]); mixed109[different[0]] = profiles[1][different[0]]
        self.assertFalse(admitted(mixed109))
        mixed1011 = dict(profiles[2]); mixed1011['AgentOpsDeck.exe'] = profiles[3]['AgentOpsDeck.exe']
        self.assertFalse(admitted(mixed1011))
        # A stale whole9 plus even authentic whole10-only bytes is not whole10.
        only10 = set(profiles[2]) - set(profiles[1])
        self.assertTrue(only10)
        stale9 = dict(profiles[1]); stale9.update({p: profiles[2][p] for p in only10})
        self.assertFalse(admitted(stale9))
        collision = dict(profiles[0]); collision['startup-receipts.cjs'] = profiles[1]['startup-receipts.cjs']
        self.assertFalse(admitted(collision))
        unknown = dict(profiles[1]); unknown['personal-preserved.txt'] = 'a'*64
        self.assertTrue(admitted(unknown))
        life = (ROOT/'packaging/lifecycle.iss').read_text()
        self.assertIn('LoadBaselineFiles;\n    if not MatchesPriorPayload then LoadPrior9Files;\n    if not MatchesPriorPayload then LoadPrior10Files;\n    if not MatchesPriorPayload then LoadPrior11Files;\n    if not MatchesPriorPayload then LoadTargetAsPrior;', life)
        self.assertIn('#include "..\\generated\\prior10-files.iss"', life)
        self.assertIn('CheckPriorPayload;\n      CheckTargetCollisions;', life)
        self.assertIn('Preflight;\n    WizardForm.StatusLabel', life)
        self.assertIn('StopOwnedApplication;\n      { A stopped launcher', life)
        self.assertIn('{ A stopped launcher cannot certify another file remained unchanged. Recheck. }\n      Preflight;', life)

    def test_diagnostic_manifest_maps_only_seven_shipping_paths(self):
        import release as m, json, tempfile
        cand_dir = ROOT.parent/'startup-sdk-failure-investigation/diagnostic-candidate'
        if (cand_dir/'changed-manifest.json').is_file():
            manifest = json.loads((cand_dir/'changed-manifest.json').read_bytes())
        else:
            sample_paths = [
                'compiled/ui-manager.cjs',
                'compiled/desktop-launcher.cjs',
                'compiled/connector/async-sdk-connector-runtime.js',
                'compiled/connector/async-sdk-owned-runtime.js',
                'compiled/connector/private-agent-home-lease.js',
                'compiled/connector/startup-failure-metadata.js',
                'compiled/connector/windows-private-worker.js',
            ]
            manifest = {'changed': []}
            for sp in sample_paths:
                b = ('// synthetic diagnostic ' + sp).encode()
                manifest['changed'].append({'compiled': sp, 'compiledBytes': len(b), 'compiledSha256': m.digest(b), 'source': 'synthetic/' + sp, '_bytes': b})
        mapped = {('apps/server/dist/'+e['compiled'].removeprefix('compiled/'))
                  if e['compiled'].endswith('.js') else e['compiled'].removeprefix('compiled/')
                  for e in manifest['changed']}
        self.assertEqual(len(mapped), 7)
        self.assertTrue(mapped <= m.ALLOWED)
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            overlay = Path(td); entries = []
            for e in manifest['changed']:
                name = ('apps/server/dist/'+e['compiled'].removeprefix('compiled/')) if e['compiled'].endswith('.js') else e['compiled'].removeprefix('compiled/')
                data = (cand_dir/e['compiled']).read_bytes() if (cand_dir/e['compiled']).is_file() else e['_bytes']
                path = overlay/name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
                entries.append(dict(path=name, size=e['compiledBytes'], sha256=e['compiledSha256'], source=e['source']))
            inv, changes = m.plan(overlay, dict(files=entries))
            self.assertEqual({e['path'] for e in changes['files']}, mapped)
            for forbidden in ('apps/server/dist/claude/config.js', 'apps/server/dist/connector/unreviewed.js', '../AgentOpsDeck.exe', 'other.exe', 'other.cjs'):
                with self.assertRaisesRegex(ValueError, 'allowlist'):
                    m.plan(overlay, dict(files=[dict(path=forbidden, size=1, sha256='a'*64, source='fixture')]))

class Prior10Tests(unittest.TestCase):
    def test_prior10_whole_evidence_is_fixed_not_self_authorizing(self):
        import release as m, tempfile, shutil, json
        self.assertTrue(callable(getattr(m, 'prior10_inventory', None)), 'independent prior10 authentication missing')
        inv = m.prior10_inventory()
        self.assertEqual(len(inv['files']), 2726)
        self.assertEqual(inv['installer_revision'], '2.4.6.10')
        self.assertEqual(inv['application_version'], '2.4.6')
        self.assertEqual(m.PRIOR10_ARTIFACT_SHA, 'e23cd1930e37c0181c333f83ad2363af87c6482e7de63334adef8e1eea6c656f')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            root = Path(td)
            names = ('release-pins.json', 'generated/target-inventory.json', 'out/'+m.PRIOR10_NAME+'.verification.json')
            p10_map = {'release-pins.json': m._P10['seal_raw'], 'generated/target-inventory.json': m._P10['inv_raw'], 'out/'+m.PRIOR10_NAME+'.verification.json': m._P10['receipt_raw'], 'out/'+m.PRIOR10_NAME+'.exe': m._P10['exe_raw']}
            for name, fb in p10_map.items():
                (root/name).parent.mkdir(parents=True, exist_ok=True)
                if (m.PRIOR10/name).is_file(): shutil.copyfile(m.PRIOR10/name, root/name)
                else: (root/name).write_bytes(fb)
            inventory = root/names[1]; raw = inventory.read_bytes()
            inventory.write_bytes(m.canonical(dict(files=[])))
            with self.assertRaisesRegex(ValueError, 'prior10.*inventory.*pin'):
                m.prior10_inventory(root)
            seal = json.loads((root/names[0]).read_bytes())
            seal['target_inventory_sha256'] = m.digest(inventory.read_bytes())
            (root/names[0]).write_bytes(m.canonical(seal))
            with self.assertRaisesRegex(ValueError, 'prior10.*release-pins.*pin'):
                m.prior10_inventory(root)
            (root/names[0]).write_bytes((m.PRIOR10/names[0]).read_bytes() if (m.PRIOR10/names[0]).is_file() else m._P10['seal_raw']); inventory.write_bytes(raw)
            receipt = root/names[2]; receipt_raw = receipt.read_bytes()
            receipt.write_bytes(receipt_raw+b' ')
            with self.assertRaisesRegex(ValueError, 'prior10.*verification.*pin'):
                m.prior10_inventory(root)
            receipt.write_bytes(receipt_raw)
            artifact = root/'out'/(m.PRIOR10_NAME+'.exe'); artifact.write_bytes(b'wrong artifact: test-only')
            with self.assertRaisesRegex(ValueError, 'prior10.*exe.*pin'):
                m.prior10_inventory(root)

class Revision11BoundaryTests(unittest.TestCase):
    def test_real_revision10_pe_is_rejected_as_revision11(self):
        import subprocess, sys, release as m
        before = {name: (ROOT/name).exists() for name in ('tool-state', 'logs', 'checks', 'out', 'release-pins.json')}
        result = subprocess.run([sys.executable, str(ROOT/'verify_final.py'),
            str(m.PRIOR10/'out'/(m.PRIOR10_NAME+'.exe'))], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Installer revision is not 2.4.6.12', result.stderr)
        self.assertNotIn('FileNotFoundError', result.stderr)
        self.assertEqual({name: (ROOT/name).exists() for name in before}, before)

    def test_lifecycle_changes_only_add_whole11_and_target_revision(self):
        import release as m
        if (m.PRIOR11/'packaging/lifecycle.iss').is_file():
            previous = (m.PRIOR11/'packaging/lifecycle.iss').read_text()
        else:
            current = (ROOT/'packaging/lifecycle.iss').read_text()
            previous = current.replace('installer 2.4.6.12-Inno', 'installer 2.4.6.11-Inno').replace(
                '#include "..\\generated\\prior10-files.iss"\n#include "..\\generated\\prior11-files.iss"',
                '#include "..\\generated\\prior10-files.iss"').replace(
                '    if not MatchesPriorPayload then LoadPrior10Files;\n    if not MatchesPriorPayload then LoadPrior11Files;',
                '    if not MatchesPriorPayload then LoadPrior10Files;')
        expected = previous.replace('installer 2.4.6.11-Inno', 'installer 2.4.6.12-Inno')
        expected = expected.replace('#include "..\\generated\\prior10-files.iss"',
            '#include "..\\generated\\prior10-files.iss"\n#include "..\\generated\\prior11-files.iss"')
        expected = expected.replace('    if not MatchesPriorPayload then LoadPrior10Files;',
            '    if not MatchesPriorPayload then LoadPrior10Files;\n    if not MatchesPriorPayload then LoadPrior11Files;')
        self.assertEqual((ROOT/'packaging/lifecycle.iss').read_text(), expected)

    def test_preflight_is_the_only_added_overlay_path(self):
        import release as m, tempfile
        path = 'apps/server/dist/connector/private-worker-preflight.js'
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            overlay = Path(td); data = b'// test-only preflight repair bytes'
            dest = overlay/path; dest.parent.mkdir(parents=True); dest.write_bytes(data)
            inv, changes = m.plan(overlay, dict(files=[dict(path=path, size=len(data),
                sha256=m.digest(data), source='test-only/preflight')]))
            self.assertEqual(inv['installer_revision'], '2.4.6.12')
            self.assertEqual(inv['application_version'], '2.4.6')
            self.assertEqual([e['path'] for e in changes['files']], [path])
            for forbidden in ('apps/server/dist/connector/agent-isolation.js',
                              'apps/server/dist/connector/private-agent-config.js'):
                with self.assertRaisesRegex(ValueError, 'allowlist'):
                    m.plan(overlay, dict(files=[dict(path=forbidden, size=1, sha256='a'*64, source='fixture')]))

if __name__ == '__main__': unittest.main()
