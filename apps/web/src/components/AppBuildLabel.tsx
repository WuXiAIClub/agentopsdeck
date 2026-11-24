import { AGENTOPSDECK_BUILD, AGENTOPSDECK_VERSION } from '@agentopsdeck/shared';

/** Compiled metadata, not the viewer's clock or the time the page was opened. */
export function AppBuildLabel({ versionLabel, buildLabel }: { versionLabel: string; buildLabel: string }) {
  const description = `${versionLabel} ${AGENTOPSDECK_VERSION} · ${buildLabel} ${AGENTOPSDECK_BUILD.buildNumber}`;
  return <span className="app-build-label" title={description} aria-label={description}>
    <span>{`v${AGENTOPSDECK_VERSION}`}</span>
    <span className="app-build-number">{AGENTOPSDECK_BUILD.buildNumber}</span>
  </span>;
}
