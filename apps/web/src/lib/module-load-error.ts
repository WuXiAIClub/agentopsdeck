// Browsers phrase failed dynamic imports differently. Do not mistake ordinary
// API/network failures or render exceptions for a stale application bundle.
export function isModuleLoadError(error: Error): boolean {
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk .+ failed|is not a valid JavaScript MIME type|Expected a JavaScript(?:-or-Wasm)? module script/i.test(error.message);
}
