import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingReceiptKey, parseBindingReceipt } from './workspace-binding-receipt.js';

test('binding recovery stores only an exact UUID, isolated by user and board', () => {
  const id = '01234567-89ab-4cde-8fab-0123456789ab';
  assert.equal(parseBindingReceipt(id), id);
  for (const invalid of [null, '', id + '\n', '../' + id, JSON.stringify({ id, token: 'secret' }), 'aod_board_secret']) {
    assert.equal(parseBindingReceipt(invalid), undefined);
  }
  assert.notEqual(bindingReceiptKey('a', 'bc'), bindingReceiptKey('ab', 'c'));
  assert.notEqual(bindingReceiptKey('a', 'board'), bindingReceiptKey('b', 'board'));
  assert.notEqual(bindingReceiptKey('a', 'one'), bindingReceiptKey('a', 'two'));
});
