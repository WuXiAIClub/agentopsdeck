// Disposable IPC transport peer; never imports an SDK or reads native state.
process.on('message', message => {
  if (message.kind === 'interrupt-compact') {
    process.send({ kind: 'interrupted' });
    return; // An ACK must not complete the original control.
  }
  const { execution, config: { scenario } } = message;
  if (scenario === 'ack-only' || scenario === 'timeout') return;
  const proof = {
    key: execution.key, id: execution.id, epoch: execution.epoch,
    nativeSessionId: execution.nativeSessionId, nativeRequestId: execution.id,
    completionEventId: 'fixture-boundary', outcome: 'completed',
  };
  if (scenario === 'wrong-id') proof.id = 'other';
  if (scenario === 'wrong-epoch') proof.epoch = 'other';
  if (scenario === 'wrong-native') proof.nativeSessionId = 'other';
  if (scenario === 'wrong-request') proof.nativeRequestId = 'other';
  if (scenario === 'extra-content') proof.text = 'must not be accepted';
  process.send({ kind: 'compact-finished', proof }, () => {
    if (scenario === 'duplicate') process.send({ kind: 'compact-finished', proof });
    else if (scenario !== 'proof-without-exit') process.exit(scenario === 'failed-exit' ? 1 : 0);
  });
});
