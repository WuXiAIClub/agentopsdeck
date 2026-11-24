#!/usr/bin/env python3
"""Build the launcher and native ACL companion without starting or installing."""
from pathlib import Path
import argparse, os, shutil, subprocess

P = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--zig', default=shutil.which('zig'))
parser.add_argument('--esbuild', default=shutil.which('esbuild'))
a = parser.parse_args()
if not a.zig or not a.esbuild:
    parser.error('Supply --zig PATH (0.14.1) and --esbuild PATH (0.28.2). No automatic installation.')
L = P / 'launcher'
O = L / 'shipping'
O.mkdir(exist_ok=True)
env = dict(os.environ, ZIG_GLOBAL_CACHE_DIR=str(P / '.build/global'), ZIG_LOCAL_CACHE_DIR=str(P / '.build/local'))
subprocess.run([a.zig, 'cc', '-target', 'x86_64-windows-gnu', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-municode', '-Wl,--subsystem,windows', str(L/'tray.c'), str(L/'resources.res'), '-o', str(O/'AgentOpsDeck.exe'), '-luser32', '-lshell32', '-lole32', '-luuid', '-ladvapi32', '-lwininet', '-lgdi32'], env=env, check=True)
R = O / 'runtime'
R.mkdir(exist_ok=True)
subprocess.run([a.zig, 'cc', '-target', 'x86_64-windows-gnu', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-municode', str(L/'private-path-check.c'), '-o', str(R/'private-path-check.exe'), '-ladvapi32'], env=env, check=True)
for src in sorted(L.glob('*.cjs')):
    if '.test.' not in src.name:
        readable = P / 'control-source' / src.name
        source = readable if readable.is_file() else src
        subprocess.run([a.esbuild, str(source), '--minify', '--platform=node', '--format=cjs', '--outfile='+str(O/src.name)], check=True)
print('Built launcher/shipping including runtime/private-path-check.exe; no services started. This is not a Claude recovery verification.')
