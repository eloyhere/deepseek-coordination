/**
 * Localized copy for the dialog options DSH itself authors.
 *
 * Most dialog content is produced by the model or by AMP and is shown as-is.
 * The plan-mode review is the exception: DSH sends two fixed English options
 * (`Approve` / `Keep planning`) and the client renders them inside the plugin's
 * otherwise localized dialog. This module maps those known source strings to
 * localized display copy; it never touches what is sent back to DSH, so answer
 * matching keeps using the original labels.
 */
import type { Locale } from '../shared/i18n.js'

export interface DialogOptionLike {
  readonly label: string
  readonly description?: string
}

interface OptionCopy {
  readonly label: string
  readonly description?: string
}

/** Source option label -> per-locale display copy. */
const PLAN_OPTIONS: Readonly<Record<string, Readonly<Partial<Record<Locale, OptionCopy>>>>> = {
  Approve: {
    en: { label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' },
    zh: { label: '批准', description: '离开计划模式，从下一步开始执行计划。' },
    ja: { label: '承認', description: 'プランモードを終了し、次のステップから計画を実行します。' },
    es: { label: 'Aprobar', description: 'Salir del modo plan; el plan se ejecuta desde el siguiente paso.' },
    fr: { label: 'Approuver', description: 'Quitter le mode plan ; le plan est exécuté à partir de l’étape suivante.' },
    de: { label: 'Genehmigen', description: 'Planmodus verlassen; der Plan wird ab dem nächsten Schritt ausgeführt.' },
    ru: { label: 'Утвердить', description: 'Выйти из режима плана; план выполняется со следующего шага.' },
    pt: { label: 'Aprovar', description: 'Sair do modo de plano; o plano é executado a partir do próximo passo.' },
  },
  'Keep planning': {
    en: { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' },
    zh: { label: '继续规划', description: '留在计划模式，反馈会返回给模型。' },
    ja: { label: '計画を続ける', description: 'プランモードのままにし、フィードバックはモデルに返されます。' },
    es: { label: 'Seguir planificando', description: 'Permanecer en el modo plan; los comentarios vuelven al modelo.' },
    fr: { label: 'Continuer à planifier', description: 'Rester en mode plan ; les retours sont renvoyés au modèle.' },
    de: { label: 'Weiter planen', description: 'Im Planmodus bleiben; Rückmeldungen gehen an das Modell.' },
    ru: { label: 'Продолжить планирование', description: 'Остаться в режиме плана; отзыв возвращается модели.' },
    pt: { label: 'Continuar planejando', description: 'Permanecer no modo de plano; o feedback volta para o modelo.' },
  },
}

/**
 * Localize one known option for display.
 *
 * Unknown labels pass through unchanged, so model-authored options are never
 * rewritten. The returned object is display-only; callers keep using the
 * original `option.label` as the answer value.
 */
export function localizeDialogOption(option: DialogOptionLike, locale: Locale): DialogOptionLike {
  const entry = PLAN_OPTIONS[option.label]
  if (entry === undefined) return option
  const copy = entry[locale] ?? entry.en
  if (copy === undefined) return option
  return {
    label: copy.label,
    ...(option.description === undefined
      ? {}
      : { description: copy.description ?? option.description }),
  }
}
