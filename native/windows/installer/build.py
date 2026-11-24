#!/usr/bin/env python3
"""Compile only an explicitly sealed, verified candidate; verify the final EXE."""
from pathlib import Path
import subprocess
import sys
from release import ROOT, prepare, verify_seal


def main():
    verify_seal()  # No compiler/tool state created for an unsealed candidate.
    prepare()
    subprocess.run([sys.executable, 'release.py', 'check'], cwd=ROOT, check=True)
    logs = ROOT/'logs'; logs.mkdir(exist_ok=True)
    with (logs/'focused-tests.log').open('w') as stream:
        subprocess.run([sys.executable, '-m', 'unittest', '-v', 'test_release', 'test_scaffold'], cwd=ROOT,
                       stdout=stream, stderr=subprocess.STDOUT, check=True)
    from toolchain import run_tool
    with (logs/'product-compile.log').open('w') as stream:
        run_tool('iscc', ['packaging/AgentOpsDeck.iss'], stream)
    subprocess.run([sys.executable, 'verify_final.py'], cwd=ROOT, check=True)
    print('PACKAGING/EXTRACTED TARGET PASS; startup repair and native Windows acceptance NOT CERTIFIED.')


if __name__ == '__main__': main()
