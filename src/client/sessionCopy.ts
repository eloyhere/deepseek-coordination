/**
 * Localized words for AMP session-list chips.
 *
 * The Chinese table covers every state the AMP kernel emits; the other locales
 * translate the states a reader meets most often and fall back to the raw
 * identifier (de-underscored) for the long tail. Listing every state in eight
 * languages would mean translating identifiers nobody sees.
 */

const ZH: Record<string, string> = {
  active: '进行中', achieved: '已达成', abandoned: '已放弃', blocked: '受阻', unblocked: '已解除阻塞',
  cancelled: '已取消', completed: '已完成', failed: '失败', pending: '待处理', proposed: '待确认',
  draft: '草稿', approved: '已批准', executing: '执行中', ready: '就绪', in_progress: '进行中',
  running: '执行中', succeeded: '成功', completed_after_cancel: '取消后完成', cancel_requested: '已请求取消',
  draining: '收尾中', unknown_outcome: '结果待确认', verification_pending: '等待验证', valid: '有效', invalidated: '已失效',
  mounted: '已纳入上下文', unmounted: '未纳入上下文', stale: '已过期', received: '已收到', interpreting: '理解请求中',
  acting: '执行任务中', responding: '生成回复中', accepted: '已确认', captured: '已记录', fulfilled: '已满足',
  idle: '空闲', closed: '已结束', suspended: '已暂停', expired: '已过期', rejected: '未通过',
}

/** The states a reader meets most often, in the six non-Chinese interface locales. */
const LOCALIZED: Readonly<Record<string, Record<string, string>>> = {
  en: {
    active: 'Active', achieved: 'Achieved', abandoned: 'Abandoned', blocked: 'Blocked', cancelled: 'Cancelled',
    completed: 'Completed', failed: 'Failed', pending: 'Pending', approved: 'Approved', executing: 'Running',
    ready: 'Ready', in_progress: 'In progress', succeeded: 'Succeeded', idle: 'Idle', closed: 'Closed', rejected: 'Rejected',
  },
  ja: {
    active: 'アクティブ', achieved: '達成済み', abandoned: '中止', blocked: 'ブロック', cancelled: 'キャンセル済み',
    completed: '完了', failed: '失敗', pending: '保留中', approved: '承認済み', executing: '実行中',
    ready: '準備完了', in_progress: '進行中', succeeded: '成功', idle: '待機中', closed: '終了', rejected: '却下',
  },
  es: {
    active: 'Activo', achieved: 'Logrado', abandoned: 'Abandonado', blocked: 'Bloqueado', cancelled: 'Cancelado',
    completed: 'Completado', failed: 'Fallido', pending: 'Pendiente', approved: 'Aprobado', executing: 'En ejecución',
    ready: 'Listo', in_progress: 'En curso', succeeded: 'Correcto', idle: 'Inactivo', closed: 'Cerrado', rejected: 'Rechazado',
  },
  fr: {
    active: 'Actif', achieved: 'Atteint', abandoned: 'Abandonné', blocked: 'Bloqué', cancelled: 'Annulé',
    completed: 'Terminé', failed: 'Échoué', pending: 'En attente', approved: 'Approuvé', executing: 'En cours',
    ready: 'Prêt', in_progress: 'En cours', succeeded: 'Réussi', idle: 'Inactif', closed: 'Fermé', rejected: 'Rejeté',
  },
  de: {
    active: 'Aktiv', achieved: 'Erreicht', abandoned: 'Aufgegeben', blocked: 'Blockiert', cancelled: 'Abgebrochen',
    completed: 'Abgeschlossen', failed: 'Fehlgeschlagen', pending: 'Ausstehend', approved: 'Genehmigt', executing: 'Wird ausgeführt',
    ready: 'Bereit', in_progress: 'Läuft', succeeded: 'Erfolgreich', idle: 'Leerlauf', closed: 'Beendet', rejected: 'Abgelehnt',
  },
  ru: {
    active: 'Активно', achieved: 'Достигнуто', abandoned: 'Заброшено', blocked: 'Заблокировано', cancelled: 'Отменено',
    completed: 'Завершено', failed: 'Ошибка', pending: 'В ожидании', approved: 'Утверждено', executing: 'Выполняется',
    ready: 'Готово', in_progress: 'В процессе', succeeded: 'Успешно', idle: 'Простой', closed: 'Закрыто', rejected: 'Отклонено',
  },
  pt: {
    active: 'Ativo', achieved: 'Alcançado', abandoned: 'Abandonado', blocked: 'Bloqueado', cancelled: 'Cancelado',
    completed: 'Concluído', failed: 'Falhou', pending: 'Pendente', approved: 'Aprovado', executing: 'Em execução',
    ready: 'Pronto', in_progress: 'Em andamento', succeeded: 'Concluído', idle: 'Ocioso', closed: 'Encerrado', rejected: 'Rejeitado',
  },
}

/** One chip label for a kernel state, in the interface locale. */
export function sessionStateLabel(value: string, locale: string): string {
  const tag = locale.toLowerCase().slice(0, 2)
  if (tag === 'zh') return ZH[value] ?? value
  const table = LOCALIZED[tag] ?? LOCALIZED.en
  const hit = table[value]
  if (hit !== undefined) return hit
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
