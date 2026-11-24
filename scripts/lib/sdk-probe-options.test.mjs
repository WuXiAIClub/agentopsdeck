import assert from 'node:assert/strict';
import test from 'node:test';
import { sdkProbeOptions } from './sdk-probe-options.mjs';

test('SDK acceptance options preserve an explicit candidate through isolated supervision', () => {
  assert.deepEqual(sdkProbeOptions(['/settings.json']), {
    settingsFile: '/settings.json', fileBoards: false, fileCards: false, businessContent: false, candidate: undefined, childArgs: [],
  });
  const result = sdkProbeOptions(['/settings.json', '--candidate', '/release', '--file-boards']);
  assert.equal(result.fileBoards, true);
  assert.equal(result.candidate, '/release');
  assert.deepEqual(sdkProbeOptions(['/settings.json', ...result.childArgs]), result);
  const cards = sdkProbeOptions(['/settings.json', '--file-cards', '--candidate', '/release']);
  assert.equal(cards.fileCards, true);
  assert.deepEqual(sdkProbeOptions(['/settings.json', ...cards.childArgs]), cards);
  const business = sdkProbeOptions(['/settings.json', '--file-card-content', '--candidate', '/release']);
  assert.equal(business.fileCards, true); assert.equal(business.businessContent, true);
  assert.deepEqual(sdkProbeOptions(['/settings.json', ...business.childArgs]), business);
});

test('SDK acceptance refuses ambiguous options before launching anything', () => {
  for (const args of [[], ['relative.json'], ['/settings.json', '--candidate'],
    ['/settings.json', '--candidate', 'relative'], ['/settings.json', '--unknown'],
    ['/settings.json', '--file-boards', '--file-boards'],
    ['/settings.json', '--file-cards', '--file-cards'], ['/settings.json', '--file-cards', '--file-boards'],
    ['/settings.json', '--file-card-content', '--file-boards'], ['/settings.json', '--file-card-content', '--file-cards'],
    ['/settings.json', '--file-card-content', '--file-card-content'],
    ['/settings.json', '--candidate', '/a', '--candidate', '/b']]) {
    assert.throws(() => sdkProbeOptions(args));
  }
});
