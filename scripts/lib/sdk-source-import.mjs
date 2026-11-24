// A single loader graph per disposable probe process. Repeated tsImport()
// namespaces across helpers unnecessarily re-load the same execution layer.
let loader;
export async function sdkSourceImport(specifier, parent) {
  loader ??= import('../../apps/server/node_modules/tsx/dist/esm/api/index.mjs').then(({ register }) => register());
  await loader;
  return import(new URL(specifier, parent).href);
}
