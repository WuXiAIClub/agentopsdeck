/** Budget for collected Connector JSON transport bytes retained by an HTTP
 * aggregation. NOT a complete JS heap bound or original SQL settlement proof.
 * All reservations are process-local, have no deadline and must remain held
 * until the original route work settles. No writes, retries or authority. */
export class ConnectorResponseBudgetExceeded extends Error {
  constructor() { super('Connector response budget exceeded'); }
}

export interface ConnectorResponseCollector {
  consume(bytes: number): void;
}

function positiveBytes(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid response budget');
}

export class ConnectorResponseBudgetPool {
  private retained = 0;
  constructor(readonly maximumBytes: number) { positiveBytes(maximumBytes); }
  get retainedBytes() { return this.retained; }

  acquire(maximumRequestBytes: number) {
    positiveBytes(maximumRequestBytes);
    if (maximumRequestBytes > this.maximumBytes) throw new RangeError('Invalid response budget');
    let retained = 0, closed = false, refused = false;
    const consume = (bytes: number) => {
      // Once refused, this original aggregation may not resume with a smaller
      // chunk or publish a partial successful snapshot. Another fresh GET can
      // acquire a new reservation after original work is settled.
      if (closed || refused || !Number.isSafeInteger(bytes) || bytes < 0
        || bytes > maximumRequestBytes - retained || bytes > this.maximumBytes - this.retained) {
        refused = true;
        throw new ConnectorResponseBudgetExceeded();
      }
      retained += bytes; this.retained += bytes;
    };
    return {
      consume,
      snapshot: () => ({ retainedBytes: retained, refused, closed }),
      close: () => {
        if (closed) return;
        closed = true;
        this.retained -= retained;
        retained = 0;
      },
    };
  }
}
