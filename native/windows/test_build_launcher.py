import contextlib
import io
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
import struct
from verify_build import verify_windows_executable


SCRIPT = Path(__file__).with_name("build-launcher.py")


def fixture(root):
    root = Path(root)
    launcher = root / "launcher"
    readable = root / "control-source"
    launcher.mkdir()
    readable.mkdir()
    script = root / "build-launcher.py"
    script.write_text(SCRIPT.read_text(encoding="utf-8"), encoding="utf-8")
    (launcher / "tray.c").write_text("/* fixture */", encoding="utf-8")
    (launcher / "private-path-check.c").write_text("/* fixture */", encoding="utf-8")
    (launcher / "resources.res").write_bytes(b"fixture")
    (launcher / "module.cjs").write_text("shipping", encoding="utf-8")
    (readable / "module.cjs").write_text("readable", encoding="utf-8")
    (launcher / "module.test.cjs").write_text("not shipped", encoding="utf-8")
    return script


class BuildLauncherTests(unittest.TestCase):
    def test_builds_launcher_and_acl_companion_without_running_or_installing(self):
        with tempfile.TemporaryDirectory(prefix="agentopsdeck-build-plan-") as directory:
            script = fixture(directory)
            arguments = [str(script), "--zig", "fixture-zig", "--esbuild", "fixture-esbuild"]
            with patch("sys.argv", arguments), patch("subprocess.run") as run:
                with contextlib.redirect_stdout(io.StringIO()):
                    runpy.run_path(str(script), run_name="__main__")
            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(len(commands), 3)
            ui, acl, control = commands
            self.assertEqual(ui[:4], ["fixture-zig", "cc", "-target", "x86_64-windows-gnu"])
            self.assertEqual(acl[:4], ui[:4])
            self.assertIn("-municode", acl)
            self.assertIn(str(script.parent / "launcher" / "private-path-check.c"), acl)
            self.assertEqual(
                acl[acl.index("-o") + 1],
                str(script.parent / "launcher" / "shipping" / "runtime" / "private-path-check.exe"),
            )
            self.assertIn("-ladvapi32", acl)
            self.assertEqual(control[0], "fixture-esbuild")
            self.assertEqual(control[1], str(script.parent / "control-source" / "module.cjs"))
            self.assertTrue(all(call.kwargs.get("check") is True for call in run.call_args_list))
            self.assertTrue((script.parent / "launcher" / "shipping" / "runtime").is_dir())

    def test_missing_toolchain_refuses_without_installing_dependencies(self):
        with tempfile.TemporaryDirectory(prefix="agentopsdeck-build-missing-") as directory:
            script = fixture(directory)
            with patch("sys.argv", [str(script)]), patch("shutil.which", return_value=None):
                with patch("subprocess.run") as run, contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as failure:
                        runpy.run_path(str(script), run_name="__main__")
            self.assertEqual(failure.exception.code, 2)
            self.assertEqual(run.call_count, 0)

    def test_windows_executable_verifier_checks_x64_subsystem_and_resources(self):
        with tempfile.TemporaryDirectory(prefix="agentopsdeck-pe-") as directory:
            file = Path(directory) / "fixture.exe"
            data = bytearray(512)
            data[:2] = b"MZ"
            struct.pack_into("<I", data, 0x3C, 128)
            data[128:132] = b"PE\0\0"
            struct.pack_into("<HH", data, 132, 0x8664, 1)
            struct.pack_into("<H", data, 148, 240)
            struct.pack_into("<H", data, 152, 0x20B)
            struct.pack_into("<H", data, 220, 2)
            data[392:400] = b".rsrc\0\0\0"
            file.write_bytes(data)
            self.assertEqual(verify_windows_executable(file, 2)["machine"], "x86_64")
            for offset, value in [(132, 0x14C), (152, 0x10B), (220, 3)]:
                altered = bytearray(data)
                struct.pack_into("<H", altered, offset, value)
                file.write_bytes(altered)
                with self.assertRaises(ValueError):
                    verify_windows_executable(file, 2)
            file.write_bytes(data[:200])
            with self.assertRaises(ValueError):
                verify_windows_executable(file, 2)
            data[392:400] = b".text\0\0\0"
            file.write_bytes(data)
            with self.assertRaises(ValueError):
                verify_windows_executable(file, 2)


if __name__ == "__main__":
    unittest.main()
