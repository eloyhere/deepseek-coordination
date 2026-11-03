/**
 * Copy owned by the simplified `协调` settings page.
 *
 * The page chrome (the four quick switches, the default-value block, the reset
 * confirmations, row badges) keeps its words here instead of
 * `src/shared/i18n.ts`, so this page can be reduced without editing the shared
 * catalog that the rest of the plugin and the i18n audit pin. Row labels and
 * hints still come from the shared catalog through `settingsControlCopy`; this
 * file only names the affordances the page adds.
 *
 * Every template placeholder is identical in both locales, matching the rest of
 * the plugin's i18n convention.
 */
import type { Locale } from '../shared/i18n.js'

/** The page chrome's words, one locale at a time. */
export interface SettingsPageCopy {
  /** Heading of the four always-visible switches. */
  readonly quickTitle: string
  /**
   * The fourth quick switch: host-side file-access takeover.
   *
   * The catalog row currently borrows the dialog-takeover copy id, so this page
   * names that gate itself instead of showing the dialog label twice.
   */
  readonly takeoverFilesLabel: string
  /** One plain sentence: plugin-executed gate, out-of-workspace writes refused. */
  readonly takeoverFilesHint: string
  /** Heading of the three new-task defaults. */
  readonly defaultsTitle: string
  /** Heading of the two display switches. */
  readonly displayTitle: string
  /** The label above the closed group accordions. */
  readonly advanced: string
  /** `{groups}` groups and `{rows}` rows behind the advanced label. */
  readonly advancedCount: string
  /** Suffix of the scene page: `情景策略 · 六个情景`. */
  readonly sceneAll: string
  /** Restore every changed value to its schema default (top action). */
  readonly restoreAll: string
  readonly restoreOneTitle: string
  /** `{label}` and `{value}` of the one row being restored. */
  readonly restoreOneBody: string
  readonly restoreAllTitle: string
  /** `{count}` rows returning to their defaults. */
  readonly restoreAllBody: string
  readonly confirmRestore: string
  readonly cancel: string
  /** Badge on a stored-but-unread row. */
  readonly notApplied: string
  readonly notAppliedTitle: string
  /** Inline reason when the host refuses one row; that row has been rolled back. */
  readonly writeRejected: string
  /** Inline reason when the host is unreachable; that row has been rolled back. */
  readonly writeOffline: string
  /** Page-level reason when a restore-all is refused; the values were rolled back. */
  readonly restoreAllRejected: string
  /** Page-level reason when a restore-all cannot reach the host. */
  readonly restoreAllOffline: string
  /** The info affordance beside the title: how changes apply now. */
  readonly applyHint: string
  readonly footer: string
  /** `{version}`, `{dependencies}` and `{tooling}` of the About section. */
  readonly aboutSummary: string
  /** `{count}` citations. */
  readonly referencesSummary: string
  /** `{name}` of the maintainer. */
  readonly authorSummary: string
}

const ZH: SettingsPageCopy = {
  quickTitle: '常用开关',
  takeoverFilesLabel: '接管文件读写',
  takeoverFilesHint: '开启后由本插件判定文件读写：越界写入会被拒绝、读取会被记录；关闭时完全不介入。',
  defaultsTitle: '新任务默认值',
  displayTitle: '显示',
  advanced: '高级设置',
  advancedCount: '{groups} 组 · {rows} 项',
  sceneAll: '六个情景',
  restoreAll: '恢复全部默认',
  restoreOneTitle: '恢复这一项的默认值？',
  restoreOneBody: '「{label}」会立即回到默认值 {value}，并写入主机。',
  restoreAllTitle: '恢复全部默认值？',
  restoreAllBody: '已改过的 {count} 项会立即回到默认值，并写入主机。',
  confirmRestore: '恢复默认',
  cancel: '取消',
  notApplied: '暂不生效',
  notAppliedTitle: '已写入；当前版本尚未读取这一项。',
  writeRejected: '主机拒绝了这次修改；该行已恢复原值。',
  writeOffline: '主机未连接；该行已恢复原值，请稍后再试。',
  restoreAllRejected: '主机拒绝了这次恢复；已改回原来的值。',
  restoreAllOffline: '主机未连接；已改回原来的值，请稍后再试。',
  applyHint: '改动一经操作立即写入主机；恢复默认会先确认一次。',
  footer: '只读项来自主机配置，只能查看；其余改动一经操作立即生效。',
  aboutSummary: '版本 {version} · {dependencies} 个依赖 · {tooling} 项工具链',
  referencesSummary: '{count} 篇文献',
  authorSummary: '维护者 {name}',
}

const EN: SettingsPageCopy = {
  quickTitle: 'Common switches',
  takeoverFilesLabel: 'File read/write takeover',
  takeoverFilesHint: 'When on, this plugin decides file access: writes outside the workspace are refused and reads are recorded; off leaves DSH untouched.',
  defaultsTitle: 'New-task defaults',
  displayTitle: 'Display',
  advanced: 'Advanced settings',
  advancedCount: '{groups} groups · {rows} items',
  sceneAll: 'All six scenes',
  restoreAll: 'Restore all defaults',
  restoreOneTitle: 'Restore this default?',
  restoreOneBody: '"{label}" returns to its default {value} immediately and is written to the host.',
  restoreAllTitle: 'Restore all defaults?',
  restoreAllBody: 'The {count} changed items return to their defaults immediately and are written to the host.',
  confirmRestore: 'Restore',
  cancel: 'Cancel',
  notApplied: 'Not applied yet',
  notAppliedTitle: 'Written, but this build does not read it yet.',
  writeRejected: 'The host rejected the change; this row is back at its previous value.',
  writeOffline: 'Host unreachable; this row is back at its previous value. Try again later.',
  restoreAllRejected: 'The host rejected the restore; the previous values are back.',
  restoreAllOffline: 'Host unreachable; the previous values are back. Try again later.',
  applyHint: 'A change is written to the host as soon as you make it; restoring asks once first.',
  footer: 'Read-only rows come from host config; every other change takes effect immediately.',
  aboutSummary: 'v{version} · {dependencies} dependencies · {tooling} tooling',
  referencesSummary: '{count} references',
  authorSummary: 'Maintained by {name}',
}

/** Both shipped locales; the shape is identical so a key cannot go missing. */
export const SETTINGS_PAGE_COPY: Readonly<Record<Locale, SettingsPageCopy>> = {
  'zh-CN': ZH,
  'en-US': EN,
}

/** Copy for one locale. The record is frozen and safe to read during render. */
export function settingsPageCopy(locale: Locale): SettingsPageCopy {
  return SETTINGS_PAGE_COPY[locale]
}
