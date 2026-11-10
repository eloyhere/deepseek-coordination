/** Human commands for inspecting the AMP kernel from the GUI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { AmpHost } from './amp.js'
import { format, pickText, type Locale, type LocalizedText } from '../shared/i18n.js'

const STATUS_HEADER: LocalizedText = {
  zh: 'AMP 0.9.1 — {agents} 个智能体模块，{verbs} 个已暴露动词',
  en: 'AMP 0.9.1 — {agents} agent modules, {verbs} exposed verbs',
  ja: 'AMP 0.9.1 — エージェントモジュール {agents} 件、公開動詞 {verbs} 件',
  es: 'AMP 0.9.1 — {agents} módulos de agente, {verbs} verbos expuestos',
  fr: "AMP 0.9.1 — {agents} modules d'agent, {verbs} verbes exposés",
  de: 'AMP 0.9.1 — {agents} Agentenmodule, {verbs} exponierte Verben',
  ru: 'AMP 0.9.1 — модулей агента: {agents}, открытых глаголов: {verbs}',
  pt: 'AMP 0.9.1 — {agents} módulos de agente, {verbs} verbos expostos',
}

const STATUS_BINDING: LocalizedText = {
  zh: '租户 {tenant} / 根 {root}',
  en: 'tenant {tenant} / root {root}',
  ja: 'テナント {tenant} / ルート {root}',
  es: 'inquilino {tenant} / raíz {root}',
  fr: 'locataire {tenant} / racine {root}',
  de: 'Mandant {tenant} / Root {root}',
  ru: 'арендатор {tenant} / корень {root}',
  pt: 'locatário {tenant} / raiz {root}',
}

const STATUS_KERNEL: LocalizedText = {
  zh: '内核：{events} 个流程事件，{receipts} 个回执，{evidence} 条证据，存储 {entities} 个实体',
  en: 'kernel: {events} workflow events, {receipts} receipts, {evidence} evidence, store {entities} entities',
  ja: 'カーネル：ワークフローイベント {events} 件、レシート {receipts} 件、証拠 {evidence} 件、ストア {entities} エンティティ',
  es: 'núcleo: {events} eventos de flujo, {receipts} recibos, {evidence} evidencias, almacén {entities} entidades',
  fr: 'noyau : {events} événements de flux, {receipts} reçus, {evidence} preuves, stockage {entities} entités',
  de: 'Kernel: {events} Workflow-Ereignisse, {receipts} Belege, {evidence} Nachweise, Speicher {entities} Entitäten',
  ru: 'ядро: событий рабочего процесса — {events}, квитанций — {receipts}, доказательств — {evidence}, сущностей в хранилище — {entities}',
  pt: 'núcleo: {events} eventos de fluxo, {receipts} recibos, {evidence} evidências, armazenamento {entities} entidades',
}

const STATUS_KERNEL_UNAVAILABLE: LocalizedText = {
  zh: '内核不可用：{reason}',
  en: 'kernel unavailable: {reason}',
  ja: 'カーネルを利用できません：{reason}',
  es: 'núcleo no disponible: {reason}',
  fr: 'noyau indisponible : {reason}',
  de: 'Kernel nicht verfügbar: {reason}',
  ru: 'ядро недоступно: {reason}',
  pt: 'núcleo indisponível: {reason}',
}

const STATUS_JOURNAL: LocalizedText = {
  zh: '调用日志：{calls} 次调用',
  en: 'journal: {calls} calls',
  ja: '呼び出しログ：{calls} 件',
  es: 'registro: {calls} llamadas',
  fr: 'journal : {calls} appels',
  de: 'Protokoll: {calls} Aufrufe',
  ru: 'журнал: вызовов — {calls}',
  pt: 'registro: {calls} chamadas',
}

const STATUS_STORAGE: LocalizedText = {
  zh: '存储（{mode}）：{path}',
  en: 'storage ({mode}): {path}',
  ja: 'ストレージ（{mode}）：{path}',
  es: 'almacenamiento ({mode}): {path}',
  fr: 'stockage ({mode}) : {path}',
  de: 'Speicher ({mode}): {path}',
  ru: 'хранилище ({mode}): {path}',
  pt: 'armazenamento ({mode}): {path}',
}

const AMP_DESCRIPTION: LocalizedText = {
  zh: '显示 AMP 协议状态、内核计数与调用日志大小。',
  en: 'Show the AMP protocol status, kernel counters and call journal size.',
  ja: 'AMP プロトコルの状態、カーネルカウンター、呼び出しログのサイズを表示します。',
  es: 'Muestra el estado del protocolo AMP, los contadores del núcleo y el tamaño del registro de llamadas.',
  fr: 'Affiche l\'état du protocole AMP, les compteurs du noyau et la taille du journal des appels.',
  de: 'Zeigt den AMP-Protokollstatus, Kernel-Zähler und die Größe des Aufrufprotokolls.',
  ru: 'Показывает состояние протокола AMP, счётчики ядра и размер журнала вызовов.',
  pt: 'Mostra o status do protocolo AMP, os contadores do núcleo e o tamanho do registro de chamadas.',
}

const MODULES_DESCRIPTION: LocalizedText = {
  zh: '列出已注册的 AMP 模块及其面向模型的动词。',
  en: 'List the registered AMP modules and their model-facing verbs.',
  ja: '登録済みの AMP モジュールとモデル向け動詞を一覧表示します。',
  es: 'Lista los módulos AMP registrados y sus verbos orientados al modelo.',
  fr: 'Liste les modules AMP enregistrés et leurs verbes destinés au modèle.',
  de: 'Listet die registrierten AMP-Module und ihre modellseitigen Verben auf.',
  ru: 'Перечисляет зарегистрированные модули AMP и их глаголы для модели.',
  pt: 'Lista os módulos AMP registrados e os verbos voltados ao modelo.',
}

function statusText(host: AmpHost, locale: Locale): string {
  const lines = [
    format(pickText(STATUS_HEADER, locale), { agents: host.agentModules.length, verbs: host.catalog.length }),
    format(pickText(STATUS_BINDING, locale), { tenant: host.config.tenantId, root: host.config.rootId }),
  ]
  try {
    const snapshot = host.kernel().snapshot()
    lines.push(format(pickText(STATUS_KERNEL, locale), {
      events: snapshot.workflowEvents,
      receipts: snapshot.receiptCount,
      evidence: snapshot.evidenceCount,
      entities: snapshot.store.entities,
    }))
  } catch (error) {
    lines.push(format(pickText(STATUS_KERNEL_UNAVAILABLE, locale), {
      reason: error instanceof Error ? error.message : String(error),
    }))
  }
  lines.push(format(pickText(STATUS_JOURNAL, locale), { calls: host.journalEntries().length }))
  const storage = host.storage()
  if (typeof storage.storePath === 'string') {
    lines.push(format(pickText(STATUS_STORAGE, locale), {
      mode: String(storage.mode ?? 'workspace'),
      path: storage.storePath,
    }))
  }
  return lines.join('\n')
}

/**
 * Register the `/amp` and `/amp-modules` commands in the active host language.
 * @returns the disposer that removes every command this call registered.
 */
export function registerAmpCommands(ctx: Context, host: AmpHost, locale: Locale): () => void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.commands.register({
    name: 'amp',
    description: pickText(AMP_DESCRIPTION, locale),
    handler: () => ({ kind: 'success', text: statusText(host, locale) }),
  }))

  disposers.push(ctx.commands.register({
    name: 'amp-modules',
    description: pickText(MODULES_DESCRIPTION, locale),
    handler: () => ({
      kind: 'success',
      text: host.agentModules.map((module) => {
        const verbs = module.verbs.map((verb) => `${verb.verb}${verb.mutating ? '*' : ''}`).join(', ')
        return `attention_manifest_protocol_${module.module} — ${verbs}`
      }).join('\n'),
    }),
  }))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
