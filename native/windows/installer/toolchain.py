#!/usr/bin/env python3
"""Read-only compiler/runtime references; all Wine mutable state in NEWROOT."""
from pathlib import Path
import json
import os
import subprocess
import sys
from release import ROOT, OLD, digest
TOOLS = OLD/'tools'


def winpath(value):
    if len(value) >= 2 and value[1] == ':': return value
    return 'Z:'+str((ROOT/value).resolve() if not Path(value).is_absolute() else Path(value).resolve()).replace('/', '\\')


def command(tool, args):
    if tool not in ('iscc', 'innounp'):
        raise ValueError('tool not allowlisted')
    wine = TOOLS/'wine-runtime/Wine Stable.app/Contents/Resources/wine/bin/wine'
    if (TOOLS/'evidence/extracted-tool-inventory.json').is_file():
        evidence = (TOOLS/'evidence/extracted-tool-inventory.json').read_bytes()
        if digest(evidence) != 'd82ecc8a47cf7820c4b36fc94698f361f6559d43975d417cd0c9614fbd343581':
            raise ValueError('Tool inventory pin mismatch')
        for e in json.loads(evidence):
            p = TOOLS/e['path']
            if p.stat().st_size != e['size'] or digest(p.read_bytes()) != e['sha256']:
                raise ValueError('Pinned tool changed: '+e['path'])
        if digest(wine.read_bytes()) != 'bad3b6126b6612680e26302c0e0b7e56d6c7036eac9bf6313878bdd9039b003f':
            raise ValueError('Wine launcher pin mismatch')
    state = (ROOT.parent/'inno-installer-2.4.6-startup12/tool-state') if not (TOOLS/'evidence/extracted-tool-inventory.json').is_file() else (ROOT/'tool-state')
    env = os.environ.copy()
    env.update(HOME=str(state/'home'), WINEPREFIX=str(state/'wineprefix'), WINEARCH='win64', WINEDEBUG='-all',
               WINEDLLOVERRIDES='winemenubuilder.exe=d;mscoree,mshtml=d;winemac.drv=d;winevulkan=d',
               TMPDIR=str(state/'tmp'), XDG_CACHE_HOME=str(state/'home/cache'),
               XDG_DATA_HOME=str(state/'home/data'), DISPLAY='', MVK_CONFIG_LOG_LEVEL='0')
    converted = []
    for arg in args:
        if tool == 'iscc':
            if arg.lower().endswith('.iss') and not arg.lower().startswith('/d'):
                arg = winpath(arg)
            elif arg[:2].lower() == '/o' and arg.lower() not in ('/o-', '/o+'):
                arg = '/O'+winpath(arg[2:])
        else:
            if arg[:2] in ('-d', '-c') and len(arg) > 2:
                arg = arg[:2]+winpath(arg[2:])
            elif arg.lower().endswith(('.exe', '.0')) and not arg.startswith('-'):
                arg = winpath(arg)
        converted.append(arg)
    exe = TOOLS/('inno-extracted/{app}/ISCC.exe' if tool == 'iscc' else 'innounp-2.71.2/innounp.exe')
    return [str(wine), str(exe), *converted], env


def run_tool(tool, args, stream=None):
    argv, env = command(tool, args)
    for d in ('home/cache', 'home/data', 'tmp'):
        (ROOT/'tool-state'/d).mkdir(parents=True, exist_ok=True)
    subprocess.run(argv, env=env, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True)


if __name__ == '__main__': run_tool(sys.argv[1], sys.argv[2:])
