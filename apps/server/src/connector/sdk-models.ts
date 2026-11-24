/** Connector-local catalog: no provider requests or credentials in Hub/HTTP workers. */
export const validSdkModel = (model: unknown): model is string => typeof model === 'string'
  && model.length > 0 && model.length <= 256 && !/\s|[\x00-\x1f\x7f]/.test(model);

export function sdkModelChoices(model: string, choices: readonly string[] = []): string[] {
  if (!validSdkModel(model) || choices.length > 100 || choices.some(choice => !validSdkModel(choice))) {
    throw new Error('Invalid SDK model catalog');
  }
  const catalog = [...new Set([model, ...choices])];
  if (catalog.length > 100) throw new Error('Invalid SDK model catalog');
  return catalog;
}

export function parseSdkModelChoices(model: string, value: string | undefined): string[] {
  return sdkModelChoices(model, value?.trim() ? value.split(',').map(item => item.trim()) : []);
}

export function sdkModelAllowed(config: { model: string; modelChoices?: readonly string[] }, override?: string): boolean {
  return sdkModelChoices(config.model, config.modelChoices).includes(override ?? config.model);
}
