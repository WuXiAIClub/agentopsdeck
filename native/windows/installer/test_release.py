"""Focused packaging tests. No native Windows execution is claimed."""
import importlib.util
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parent

class ReleaseTests(unittest.TestCase):
    def test_plan_requires_reviewed_exact_helper_overlay(self):
        self.assertTrue((ROOT/'release.py').is_file(), 'overlay packaging integration missing')
        spec = importlib.util.spec_from_file_location('release11', ROOT/'release.py')
        m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
        import tempfile, json
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            overlay = Path(td)/'overlay'; overlay.mkdir()
            files = []
            for name in ('ui-manager.cjs', 'desktop-launcher.cjs', 'ui-helper.cjs'):
                data = ('// packaging test fixture, NOT repair\n'+name).encode()
                (overlay/name).write_bytes(data)
                files.append(dict(path=name, size=len(data), sha256=m.digest(data), source='test-fixture/'+name))
            manifest = dict(files=files)
            inv, changes = m.plan(overlay, manifest)
            self.assertEqual(len(inv['files']), 2723)
            self.assertEqual([f['path'] for f in changes['files']], sorted(f['path'] for f in files))
            old = {f['path']: f for f in m.baseline()['files']}
            new = {f['path']: f for f in inv['files']}
            self.assertEqual({p for p in old if old[p] != new[p]}, set(f['path'] for f in files))
            (overlay/'apps').mkdir(); (overlay/'apps/server.js').write_bytes(b'bad')
            with self.assertRaisesRegex(ValueError, 'overlay file set'):
                m.plan(overlay, manifest)

    def test_seal_requires_explicit_pins_and_rejects_mutated_trees(self):
        import release as m
        import tempfile
        self.assertTrue(callable(getattr(m, 'seal', None)), 'explicit seal missing')
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            root = Path(td); overlay = root/'overlay'; overlay.mkdir()
            files = []
            for name in sorted(m.STARTUP_HELPERS):
                data = ('// packaging seal fixture NOT repair '+name).encode()
                (overlay/name).write_bytes(data)
                files.append(dict(path=name, size=len(data), sha256=m.digest(data), source='fixture/'+name))
            manifest = root/'reviewed.json'; manifest.write_bytes(m.canonical(dict(files=files)))
            inv, changes = m.plan(overlay, dict(files=files))
            pins = (m.digest(manifest.read_bytes()), m.digest(m.canonical(inv)), m.digest(m.canonical(changes)))
            with self.assertRaisesRegex(ValueError, 'explicit target'):
                m.seal(root/'bad', overlay, manifest, pins[0], '0'*64, pins[2])
            stage = root/'sealed'
            m.seal(stage, overlay, manifest, *pins)
            self.assertEqual(m.verify_seal(stage)['installer_revision'], '2.4.6.12')
            m.prepare(stage)
            m.verify_tree(stage/'payload', inv['files'])
            helper = stage/'payload/ui-manager.cjs'; old = helper.read_bytes()
            helper.write_bytes(old+b'changed')
            with self.assertRaisesRegex(ValueError, 'byte mismatch'):
                m.verify_tree(stage/'payload', inv['files'])
            helper.write_bytes(old); helper.unlink()
            with self.assertRaisesRegex(ValueError, 'missing'):
                m.verify_tree(stage/'payload', inv['files'])
            helper.write_bytes(old); added = stage/'payload/unreviewed.cjs'; added.write_bytes(b'added')
            with self.assertRaisesRegex(ValueError, 'Unexpected'):
                m.verify_tree(stage/'payload', inv['files'])
            added.unlink()
            m.verify_tree(stage/'payload', inv['files'])
            # A different valid JSON inventory cannot self-authorize by hashing itself.
            (stage/'generated/target-inventory.json').write_bytes(m.canonical(dict(files=[])))
            with self.assertRaisesRegex(ValueError, 'sealed inventory'):
                m.verify_seal(stage)

    def test_tables_keep_old_authentication_separate_from_target_collisions(self):
        import release as m
        self.assertTrue(callable(getattr(m, 'render_inputs', None)), 'split packaging generator missing')
        old = m.baseline(); target = dict(old)
        target['files'] = [dict(e) for e in old['files']]
        for e in target['files']:
            if e['path'] == 'ui-manager.cjs': e['sha256'] = 'f'*64
        inputs = m.render_inputs(target)
        self.assertIn("KnownFiles.Add('ui-manager.cjs|"+'f'*64+"');", inputs['target-files.iss'])
        helper = next(e for e in old['files'] if e['path'] == 'ui-manager.cjs')
        self.assertIn("PriorFiles.Add('ui-manager.cjs|"+helper['sha256']+"');", inputs['trusted-baseline.iss'])
        self.assertNotIn('KnownFiles.Add(', inputs['trusted-baseline.iss'])
        self.assertEqual(inputs['trusted-priors.iss'].encode(), (m.OLD/'packaging/trusted-priors.iss').read_bytes() if (m.OLD/'packaging/trusted-priors.iss').is_file() else m._TRUSTED_PRIORS_RAW)
        self.assertEqual(inputs['trusted-priors.iss'].count('PriorFiles.Add('), 2062*4+2052+2058)
        life = (ROOT/'packaging/lifecycle.iss').read_text()
        self.assertIn('if not MatchesPriorPayload then LoadTargetAsPrior;', life)
        self.assertIn('if Marker = LegacyId then LoadBaselineFiles;', life)
        self.assertIn('CheckPriorPayload;\n      CheckTargetCollisions;', life)
        self.assertIn('ErrorCode := DLLGetLastError;', life)
        self.assertIn('if not Modern then begin', life)
        recipe = (ROOT/'packaging/AgentOpsDeck.iss').read_text()
        self.assertIn('AppId=AgentOpsDeck.Desktop.CurrentUser', recipe)
        self.assertIn('VersionInfoVersion=2.4.6.12', recipe)
        self.assertIn('Check: ShouldCreateDesktopShortcut', recipe)

    def test_verifier_rejects_old8_pe_without_seal_or_extraction(self):
        import subprocess, sys
        script = ROOT/'verify_final.py'
        self.assertTrue(script.is_file(), 'final extractor gate missing')
        old = ROOT.parent/'inno-installer-2.4.6/out/AgentOpsDeck-Setup-2.4.6.8-Inno-Windows-x64.exe'
        result = subprocess.run([sys.executable, str(script), str(old)], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Installer revision is not 2.4.6.12', result.stderr)
        self.assertNotIn('FileNotFoundError', result.stderr)

    def test_plan_cli_reports_identity_without_writing_a_seal(self):
        import release as m
        import subprocess, sys, tempfile, json
        before_seal = (ROOT/'release-pins.json').read_bytes() if (ROOT/'release-pins.json').exists() else None
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            root = Path(td); overlay = root/'overlay'; overlay.mkdir()
            files = []
            for name in sorted(m.STARTUP_HELPERS):
                data = ('// CLI fixture NOT repair '+name).encode(); (overlay/name).write_bytes(data)
                files.append(dict(path=name, size=len(data), sha256=m.digest(data), source='fixture/'+name))
            manifest = root/'reviewed.json'; manifest.write_bytes(m.canonical(dict(files=files)))
            result = subprocess.run([sys.executable, str(ROOT/'release.py'), 'plan', '--overlay', str(overlay),
                                     '--manifest', str(manifest)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(result.stdout.strip(), 'plan CLI missing')
            out = json.loads(result.stdout)
            inv, changes = m.plan(overlay, dict(files=files))
            self.assertEqual(out['target_inventory_sha256'], m.digest(m.canonical(inv)))
            self.assertEqual(out['changed_file_manifest_sha256'], m.digest(m.canonical(changes)))
            after_seal = (ROOT/'release-pins.json').read_bytes() if (ROOT/'release-pins.json').exists() else None
            self.assertEqual(after_seal, before_seal, 'test fixtures must not seal production')

    def test_toolchain_uses_readonly_old_binaries_with_new_state(self):
        self.assertTrue((ROOT/'toolchain.py').is_file(), 'isolated tool launcher missing')
        import toolchain as t
        argv, env = t.command('iscc', ['packaging/AgentOpsDeck.iss'])
        self.assertIn('inno-installer-2.4.6/tools/', argv[0])
        self.assertIn('inno-installer-2.4.6-startup12/tool-state/', env['WINEPREFIX'])
        self.assertIn('inno-installer-2.4.6-startup12/tool-state/', env['HOME'])
        self.assertTrue(argv[-1].startswith('Z:'))
        argv, _ = t.command('innounp', ['-x', '-dchecks/test', 'out/test.exe'])
        self.assertTrue(argv[-2].startswith('-dZ:'))
        self.assertTrue(argv[-1].startswith('Z:'))
        with self.assertRaises(ValueError): t.command('arbitrary', [])

    def test_build_fails_closed_before_compiler_without_reviewed_seal(self):
        import subprocess, sys
        self.assertTrue((ROOT/'build.py').is_file(), 'build entry missing')
        # Unsealed disposable root, not the real candidate's seal.
        import tempfile, shutil
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            root = Path(td)
            for name in ('build.py', 'release.py'):
                shutil.copyfile(ROOT/name, root/name)
            result = subprocess.run([sys.executable, str(root/'build.py')], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('release-pins.json', result.stderr)
            for forbidden in ('tool-state', 'logs', 'out', 'payload', 'generated', 'release-pins.json'):
                self.assertFalse((root/forbidden).exists(), forbidden)

    def test_overlay_can_contain_only_helpers_actually_changed(self):
        import release as m
        import tempfile
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            overlay = Path(td)
            data = b'// subset packaging fixture NOT repair'
            (overlay/'ui-manager.cjs').write_bytes(data)
            inv, changes = m.plan(overlay, dict(files=[dict(path='ui-manager.cjs', size=len(data),
                sha256=m.digest(data), source='fixture/ui-manager.cjs')]))
            self.assertEqual(len(changes['files']), 1)
            self.assertEqual(len(inv['files']), 2723)

    def test_exact_observer_companion_closure_is_allowed_but_no_generic_scripts(self):
        import release as m
        import tempfile
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            overlay = Path(td)
            files = []
            for name in ('ui-manager.cjs', 'startup-receipts.cjs', 'startup-worker.cjs'):
                data = ('// isolated packaging fixture ' + name).encode()
                (overlay/name).write_bytes(data)
                files.append(dict(path=name, size=len(data), sha256=m.digest(data), source='fixture/'+name))
            inv, changes = m.plan(overlay, dict(files=files))
            self.assertEqual(len(inv['files']), 2725)
            self.assertEqual({e['path'] for e in changes['files']}, {e['path'] for e in files})
            (overlay/'arbitrary-worker.cjs').write_bytes(b'bad')
            files.append(dict(path='arbitrary-worker.cjs', size=3, sha256=m.digest(b'bad'), source='fixture/bad'))
            with self.assertRaisesRegex(ValueError, 'allowlist'):
                m.plan(overlay, dict(files=files))

if __name__ == '__main__': unittest.main()
