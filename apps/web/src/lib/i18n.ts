import { useSyncExternalStore } from 'react';
import type { Locale, TranslationKey, TranslationParams } from './translations.js';
export type { Locale, TranslationKey } from './translations.js';

const key = 'agentopsdeck.locale';
const listeners = new Set<() => void>();
let locale: Locale = 'en';
let loadedChinese: Record<string, string> | undefined;
let loadingChinese: Promise<Record<string, string>> | undefined;
let chineseLoadFailed = false;

export function resolveLocale(stored?: string | null, browserLanguage = 'en'): Locale {
  if (stored === 'en' || stored === 'zh-CN') return stored;
  return /^zh(?:-|$)/i.test(browserLanguage) ? 'zh-CN' : 'en';
}

function preferredLocale() {
  let stored: string | null = null;
  try { stored = localStorage.getItem(key); } catch { /* Storage may be unavailable. */ }
  return resolveLocale(stored, typeof navigator === 'undefined' ? 'en' : navigator.language);
}

export function ensureChineseLoaded() {
  if (loadedChinese) return Promise.resolve(loadedChinese);
  if (loadingChinese) return loadingChinese;
  chineseLoadFailed = false;
  loadingChinese = import('./translations.js').then(mod => {
    loadedChinese = mod.chinese;
    listeners.forEach(listener => listener());
    return loadedChinese;
  }).catch(error => {
    loadingChinese = undefined;
    chineseLoadFailed = true;
    listeners.forEach(listener => listener());
    throw error;
  });
  return loadingChinese;
}

locale = preferredLocale();
if (typeof document !== 'undefined') document.documentElement.lang = locale;
if (locale === 'zh-CN') void ensureChineseLoaded().catch(() => {});

export function translate(text: string, language: Locale = locale, params?: TranslationParams): string {
  if (language === 'zh-CN' && !loadedChinese && !chineseLoadFailed) void ensureChineseLoaded().catch(() => {});
  const template: string = language === 'zh-CN' && loadedChinese && Object.hasOwn(loadedChinese, text) ? loadedChinese[text]! : text;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

export function setLocale(value: Locale) {
  locale = value;
  try { localStorage.setItem(key, value); } catch { /* In-memory preference still works. */ }
  if (typeof document !== 'undefined') document.documentElement.lang = value;
  if (value === 'zh-CN' && !loadedChinese) {
    void ensureChineseLoaded().catch(() => {});
  }
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useI18n() {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (locale === 'zh-CN' ? (loadedChinese ? 'zh-CN:ready' : chineseLoadFailed ? 'zh-CN:failed' : 'zh-CN:loading') : 'en'),
    () => 'en',
  );
  const language: Locale = snapshot.startsWith('zh-CN') ? 'zh-CN' : 'en';
  return { locale: language, setLocale, t: (text: TranslationKey, params?: TranslationParams) => translate(text, language, params) };
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) {
    locale = preferredLocale();
    document.documentElement.lang = locale;
    if (locale === 'zh-CN') void ensureChineseLoaded().catch(() => {});
    listeners.forEach(listener => listener());
  }
});
