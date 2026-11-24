/** Sanitized classification for a failed READ, never permission to run an effect. */
export type ObservationFailureCode = 'observation_unavailable' | 'transport_unavailable';
export class MaintenanceObservationUnavailable extends Error {
  constructor(readonly code: ObservationFailureCode) {
    super('Connector maintenance response unavailable or unverified');
  }
}
