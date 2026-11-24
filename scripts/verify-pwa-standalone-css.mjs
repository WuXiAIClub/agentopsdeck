#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const css = fs.readFileSync(path.join(root, 'apps/web/src/styles.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'apps/web/src/main.tsx'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'apps/web/public/manifest.webmanifest'), 'utf8'));

const checks = [
  ['standalone html class toggled', main.includes("classList.toggle('pwa-standalone'")],
  ['standalone display mode passed into shell selection', main.includes('isMobileLikeDevice(width, standalone)')],
  ['stable app viewport variable maintained', main.includes('--aod-app-vh') && css.includes('--aod-app-vh')],
  ['desktop shell uses standalone safe-area insets', css.includes('.pwa-standalone .desktop-workspace-shell') && css.includes('env(safe-area-inset-top)')],
  ['mobile composer accounts for keyboard offset', css.includes('--aod-keyboard-offset')],
  ['mobile composer accounts for PWA side safe areas', css.includes('.pwa-standalone .mobile-chat-composer') && css.includes('env(safe-area-inset-left)')],
  ['manifest allows portrait and landscape PWA rotation', manifest.orientation === 'any'],
];

const failed = checks.filter(([, pass]) => !pass);
for (const [name, pass] of checks) {
  console.log(`${pass ? 'ok' : 'not ok'} - ${name}`);
}

if (failed.length > 0) {
  process.exitCode = 1;
}
