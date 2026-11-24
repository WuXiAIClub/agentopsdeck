import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

/** Explicit source-build or fixed-candidate acceptance; no ambient env override. */
export function sdkProbeOptions(args) {
  const [settingsFile, ...flags] = args;
  assert.ok(settingsFile && isAbsolute(settingsFile), 'An absolute probe settings file is required');
  let fileBoards = false, fileCards = false, businessContent = false, candidate;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === '--file-boards' && !fileBoards) fileBoards = true;
    else if (flag === '--file-cards' && !fileCards) fileCards = true;
    else if (flag === '--file-card-content' && !businessContent) businessContent = true;
    else if (flag === '--candidate' && !candidate) {
      candidate = flags[++index];
      assert.ok(candidate && isAbsolute(candidate), 'An absolute candidate directory is required');
    } else throw new Error('Unknown or duplicate SDK probe option');
  }
  assert.ok(Number(fileBoards) + Number(fileCards) + Number(businessContent) <= 1, 'Select a single file acceptance mode');
  return { settingsFile, fileBoards, fileCards: fileCards || businessContent, businessContent, candidate,
    childArgs: [...(fileBoards ? ['--file-boards'] : []), ...(fileCards ? ['--file-cards'] : []),
      ...(businessContent ? ['--file-card-content'] : []), ...(candidate ? ['--candidate', candidate] : [])] };
}
