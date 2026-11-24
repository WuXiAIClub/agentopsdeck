import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldUseMobileShell } from './device-layout.js';

test('iPad Safari uses desktop shell even in portrait-sized viewport', () => {
  assert.equal(shouldUseMobileShell({ width: 810, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 }), false);
});

test('iPadOS desktop user agent uses desktop shell', () => {
  assert.equal(shouldUseMobileShell({ width: 1024, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', maxTouchPoints: 5 }), false);
});

test('iPad standalone PWA keeps desktop shell at normal portrait tablet width', () => {
  assert.equal(shouldUseMobileShell({ width: 810, userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5, standalone: true }), false);
});

test('iPad standalone PWA uses mobile shell in compact Slide Over width', () => {
  assert.equal(shouldUseMobileShell({ width: 744, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', maxTouchPoints: 5, standalone: true }), true);
});

test('iPad browser compact width still preserves tablet desktop shell choice', () => {
  assert.equal(shouldUseMobileShell({ width: 744, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15', maxTouchPoints: 5 }), false);
});

test('iPhone remains on mobile shell', () => {
  assert.equal(shouldUseMobileShell({ width: 430, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', maxTouchPoints: 5 }), true);
});

test('very narrow desktop browser can still use mobile shell', () => {
  assert.equal(shouldUseMobileShell({ width: 520, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', maxTouchPoints: 0 }), true);
});

test('desktop width with touch laptop stays desktop', () => {
  assert.equal(shouldUseMobileShell({ width: 1200, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', maxTouchPoints: 10 }), false);
});
