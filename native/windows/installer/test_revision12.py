"""Revision12 repair packaging only; no recovery behavior is asserted here."""
import unittest,json,tempfile,shutil,subprocess,sys,re
from pathlib import Path
import release as m
ROOT=Path(__file__).resolve().parent
class Revision12Tests(unittest.TestCase):
    def test_revision12_identity_not_relabelled_prior11(self):
        self.assertEqual(m.REVISION,'2.4.6.12')
        recipe=(ROOT/'packaging/AgentOpsDeck.iss').read_text()
        self.assertIn('VersionInfoVersion=2.4.6.12',recipe)
        self.assertIn('OutputBaseFilename=AgentOpsDeck-Setup-2.4.6.12-Inno-Windows-x64',recipe)
        self.assertIn('AppVersion=2.4.6\n',recipe)
    def test_prior11_authentication_and_no_self_authorization(self):
        self.assertTrue(callable(getattr(m,'prior11_inventory',None)),'Independent prior11 authentication missing')
        inv=m.prior11_inventory()
        self.assertEqual((inv['installer_revision'],len(inv['files'])),('2.4.6.11',2727))
        self.assertEqual(m.PRIOR11_ARTIFACT_SHA,'6944763ebdc87929004243f5aa954bb05cb2100c7bcf74bff3383f01ccba12d6')
        names=['release-pins.json','generated/target-inventory.json','out/'+m.PRIOR11_NAME+'.verification.json']
        with tempfile.TemporaryDirectory(dir=ROOT) as td:
            root=Path(td)
            p11_map={'release-pins.json':m._P11['seal_raw'],'generated/target-inventory.json':m._P11['inv_raw'],'out/'+m.PRIOR11_NAME+'.verification.json':m._P11['receipt_raw'],'out/'+m.PRIOR11_NAME+'.exe':m._P11['exe_raw']}
            for name,fb in p11_map.items():
                (root/name).parent.mkdir(parents=True,exist_ok=True)
                if (m.PRIOR11/name).is_file():shutil.copyfile(m.PRIOR11/name,root/name)
                else:(root/name).write_bytes(fb)
            original=(root/names[1]).read_bytes()
            (root/names[1]).write_bytes(m.canonical(dict(files=[])))
            with self.assertRaisesRegex(ValueError,'prior11.*inventory.*pin'):m.prior11_inventory(root)
            seal=json.loads((root/names[0]).read_bytes());seal['target_inventory_sha256']=m.digest((root/names[1]).read_bytes())
            (root/names[0]).write_bytes(m.canonical(seal))
            with self.assertRaisesRegex(ValueError,'prior11.*release-pins.*pin'):m.prior11_inventory(root)
            (root/names[0]).write_bytes((m.PRIOR11/names[0]).read_bytes() if (m.PRIOR11/names[0]).is_file() else m._P11['seal_raw']);(root/names[1]).write_bytes(original)
            raw=(root/names[2]).read_bytes();(root/names[2]).write_bytes(raw+b' ')
            with self.assertRaisesRegex(ValueError,'prior11.*verification.*pin'):m.prior11_inventory(root)
            (root/names[2]).write_bytes(raw)
            (root/'out'/(m.PRIOR11_NAME+'.exe')).write_bytes(b'test-only wrong artifact')
            with self.assertRaisesRegex(ValueError,'prior11.*exe.*pin'):m.prior11_inventory(root)
    def test_whole11_profile_selected_before_target_not_per_file_union(self):
        self.assertTrue(callable(getattr(m,'prior11_inventory',None)))
        target=json.loads(m.canonical(m.prior11_inventory()));target['installer_revision']='2.4.6.12'
        for entry in target['files']:
            if entry['path'] in ('AgentOpsDeck.exe','ui-helper.cjs'):entry['sha256']='f'*64
        inputs=m.render_inputs(target)
        prior=inputs['prior11-files.iss'];self.assertEqual(prior.count('PriorFiles.Add('),2727)
        self.assertIn('PriorFiles.Clear;',prior)
        life=(ROOT/'packaging/lifecycle.iss').read_text()
        self.assertIn('#include "..\\generated\\prior11-files.iss"',life)
        self.assertIn('if not MatchesPriorPayload then LoadPrior11Files;\n    if not MatchesPriorPayload then LoadTargetAsPrior;',life)
        pattern=r"(?:PriorFiles|KnownFiles).Add\('([^']+)\|([0-9a-f]{64})'\);"
        old=dict(re.findall(pattern,prior));new=dict(re.findall(pattern,inputs['target-files.iss']))
        mixed=dict(old);mixed['AgentOpsDeck.exe']=new['AgentOpsDeck.exe']
        self.assertNotEqual(mixed,old);self.assertNotEqual(mixed,new)
    def test_actual_prior11_pe_is_rejected_as_revision12(self):
        old=ROOT.parent/'inno-installer-2.4.6-startup11/out/AgentOpsDeck-Setup-2.4.6.11-Inno-Windows-x64.exe'
        result=subprocess.run([sys.executable,str(ROOT/'verify_final.py'),str(old)],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Installer revision is not 2.4.6.12',result.stderr)
        self.assertNotIn('FileNotFoundError',result.stderr)
if __name__=='__main__':unittest.main()
