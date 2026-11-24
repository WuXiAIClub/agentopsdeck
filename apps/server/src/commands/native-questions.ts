import type { InteractionAnswer } from '@agentopsdeck/shared';
import type { InteractionQuestion } from './interaction-runtime.js';
import { validInteractionQuestion, wireAnswer } from './interaction-wire.js';

export type NativeQuestion = { id: string; question: InteractionQuestion; decode(answer: InteractionAnswer): string[] };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = () => new Error('Unsupported native question');
function descriptions(question: NativeQuestion, options: unknown) {
  if (Array.isArray(options) && question.question.options) {
    question.question.options.forEach((option, i) => {
      const source = options[i];
      if (record(source) && source.description !== undefined && source.description !== '') {
        if (typeof source.description !== 'string' || source.description.length > 2000) throw fail();
        option.description = source.description;
      }
    });
    if (!validInteractionQuestion(question.question)) throw fail();
  }
  return question;
}
function adapt(id: unknown, prompt: unknown, choices: unknown, multi: boolean, freeform: boolean): NativeQuestion {
  if (typeof id !== 'string' || !id.trim() || id.length > 256 || /[\x00-\x1f\x7f]/.test(id) || typeof prompt !== 'string') throw fail();
  const options = choices === undefined || choices === null ? [] : choices;
  if (!Array.isArray(options) || options.length > 32 || options.some(v => typeof v !== 'string') || new Set(options).size !== options.length) throw fail();
  if (!options.length && !freeform) throw fail();
  const question: InteractionQuestion = options.length
    ? { kind: multi ? 'multi-select' : 'single-select', prompt, options: options.map((label, i) => ({ id: String(i), label })), allowFreeform: freeform }
    : { kind: 'text', prompt };
  if (!validInteractionQuestion(question)) throw fail();
  return { id, question, decode(answer) {
    const checked = wireAnswer(question, answer);
    if (!checked || checked.kind === 'approval') throw fail();
    if (checked.kind === 'text') return [checked.text];
    return checked.text !== undefined ? [checked.text] : checked.optionIds.map(id => options[Number(id)] as string);
  } };
}
export function copilotQuestion(value: unknown): NativeQuestion {
  if (!record(value) || value.allowFreeform !== undefined && typeof value.allowFreeform !== 'boolean') throw fail();
  return adapt('answer', value.question, value.choices, false, value.allowFreeform !== false);
}
/** Secret questions are deliberately unsupported: durable public interaction
 * forms are not a credential store. Never downgrade them to ordinary text. */
export function codexQuestions(value: unknown): NativeQuestion[] {
  if (!record(value) || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 4) throw fail();
  const result = value.questions.map(q => {
    if (!record(q) || q.isSecret === true || q.isSecret !== undefined && typeof q.isSecret !== 'boolean'
      || q.isOther !== undefined && typeof q.isOther !== 'boolean') throw fail();
    const choices = q.options == null ? undefined : Array.isArray(q.options) ? q.options.map(o => { if (!record(o)) throw fail(); return o.label; }) : q.options;
    return descriptions(adapt(q.id, q.question, choices, false, q.isOther === true || choices === undefined), q.options);
  });
  if (new Set(result.map(q => q.id)).size !== result.length) throw fail();
  return result;
}
export function claudeQuestions(value: unknown): NativeQuestion[] {
  if (!record(value) || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > 4) throw fail();
  const result = value.questions.map((q, i) => {
    if (!record(q) || q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean' || !Array.isArray(q.options)) throw fail();
    return descriptions(adapt(String(i), q.question, q.options.map(o => { if (!record(o)) throw fail(); return o.label; }), q.multiSelect === true, true), q.options);
  });
  if (new Set(result.map(q => q.question.prompt)).size !== result.length) throw fail();
  return result;
}
