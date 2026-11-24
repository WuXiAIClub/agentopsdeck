import {performanceDiagnostics,type PerformanceDiagnostics} from './performance.js';

/** Fixed numeric phases only. Never record a binding, path, credential,
 * content, transport result or exception. The original Promise owns finish. */
export async function observeContentReplica<T>(operation:'hub-content-replica-effect'|'connector-content-replica-http'|'hub-content-batch-effect'|'hub-content-background',
  step:number,run:()=>Promise<T>|T,diagnostics:PerformanceDiagnostics=performanceDiagnostics):Promise<T> {
  const trace=diagnostics.start(operation);trace.add('step',step);
  const warning=operation==='hub-content-background'?setTimeout(()=>trace.reportPending({pending:1}),30_000):undefined;
  warning?.unref();
  if(!warning)trace.reportPending({pending:1});
  let failed=true;
  try {const result=await run();trace.add('settled',1);failed=false;return result;}
  finally {if(warning)clearTimeout(warning);if(failed)trace.add('unknown',1);trace.finish(failed);}
}
