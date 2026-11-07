/**
 * The locales DSH ships and the copy this plugin renders.
 *
 * DSH owns the interface language: `zh`, `en`, `ja`, `es`, `fr`, `de`, `ru`,
 * `pt`. Every dictionary in this plugin covers those eight ids so a host
 * language switch never falls back to English for a shipped locale.
 */
export const LOCALES = ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

const PRIMARY_LOCALES: Readonly<Record<string, Locale>> = {
  zh: 'zh',
  en: 'en',
  ja: 'ja',
  es: 'es',
  fr: 'fr',
  de: 'de',
  ru: 'ru',
  pt: 'pt',
}

/** Normalise any DSH locale tag (`zh`, `zh-CN`, `en-US`, `ja-JP`, ...). */
export function normaliseLocale(value: unknown): Locale {
  if (typeof value !== 'string') return DEFAULT_LOCALE
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return PRIMARY_LOCALES[primary] ?? DEFAULT_LOCALE
}

/** One string per shipped locale, used for host-registered catalog copy. */
export type LocalizedText = Readonly<Record<Locale, string>>

/** Pick the active locale's text, falling back to the DSH baseline locale. */
export function pickText(text: LocalizedText, locale: Locale): string {
  return text[locale] ?? text[DEFAULT_LOCALE]
}

/** Fill `{name}` placeholders in one dictionary template. */
export function format(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match))
}

export interface Copy {
  readonly notification: string
  readonly dismiss: string
  readonly close: string
}

export const DEFAULT_COPY: Readonly<Record<Locale, Copy>> = {
  zh: { notification: '通知', dismiss: '知道了', close: '关闭' },
  en: { notification: 'Notification', dismiss: 'Got it', close: 'Close' },
  ja: { notification: '通知', dismiss: '了解しました', close: '閉じる' },
  es: { notification: 'Notificación', dismiss: 'Entendido', close: 'Cerrar' },
  fr: { notification: 'Notification', dismiss: 'Compris', close: 'Fermer' },
  de: { notification: 'Benachrichtigung', dismiss: 'Verstanden', close: 'Schließen' },
  ru: { notification: 'Уведомление', dismiss: 'Понятно', close: 'Закрыть' },
  pt: { notification: 'Notificação', dismiss: 'Entendi', close: 'Fechar' },
}

export function copyFor(locale: Locale): Copy {
  return DEFAULT_COPY[locale] ?? DEFAULT_COPY[DEFAULT_LOCALE]
}
