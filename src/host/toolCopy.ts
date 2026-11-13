import { normaliseLocale, type Locale } from '../shared/i18n.js'

/** User-visible strings emitted by host tools and the intake popup. */
export interface ToolCopy {
  readonly readReason: string
  readonly writeReason: string
  readonly searchReason: string
  readonly proposalHeader: string
  readonly proposalQuestion: string
  readonly invalidIntake: string
  readonly intakeTimeout: string
  readonly goal: string
  readonly assumptions: string
  readonly openQuestions: string
}

const en: ToolCopy = {
  readReason: 'File-read takeover is enabled. Use AMP workspace.list, workspace.outline, then workspace.read with startLine/endLine or a byte range. Native read is disabled.',
  writeReason: 'File-write takeover is enabled. Use AMP workspace.write, or workspace.replace with expectedBaseHash/expectedBufferVersion. Native write/replace is disabled.',
  searchReason: 'Search takeover is enabled. Use attention_manifest_protocol_discover with action="search", then outline and read only the relevant ranges. Native glob/grep are disabled.',
  proposalHeader: 'Approach',
  proposalQuestion: 'Choose an approach',
  invalidIntake: 'Invalid intake arguments',
  intakeTimeout: 'intake popup timed out after 180s; no answer was recorded',
  goal: 'Goal',
  assumptions: 'Assumptions',
  openQuestions: 'Open questions',
}

const zh: ToolCopy = {
  readReason: '文件读取接管已开启。请使用 AMP workspace.list、workspace.outline，再用 workspace.read（startLine/endLine 或字节范围）。原生 read 已禁用。',
  writeReason: '文件写入接管已开启。请使用 AMP workspace.write，或带 expectedBaseHash/expectedBufferVersion 的 workspace.replace。原生 write/replace 已禁用。',
  searchReason: '搜索接管已开启。请使用 attention_manifest_protocol_discover 的 action="search"，再查看大纲并只读取相关范围。原生 glob/grep 已禁用。',
  proposalHeader: '方案选择',
  proposalQuestion: '选择一个方案方向',
  invalidIntake: 'intake 参数无效',
  intakeTimeout: 'intake 弹窗在 180 秒后超时，未记录回答',
  goal: '目标',
  assumptions: '假设',
  openQuestions: '待确认问题',
}

const ja: ToolCopy = {
  readReason: 'ファイル読み取りの引き継ぎが有効です。AMP workspace.list、workspace.outline、次に workspace.read（startLine/endLine またはバイト範囲）を使用してください。ネイティブ read は無効です。',
  writeReason: 'ファイル書き込みの引き継ぎが有効です。AMP workspace.write、または expectedBaseHash/expectedBufferVersion を付けた workspace.replace を使用してください。ネイティブ write/replace は無効です。',
  searchReason: '検索の引き継ぎが有効です。attention_manifest_protocol_discover の action="search" を使用し、アウトラインを確認して必要な範囲だけを読んでください。ネイティブ glob/grep は無効です。',
  proposalHeader: 'アプローチ',
  proposalQuestion: 'アプローチを選択',
  invalidIntake: 'intake 引数が無効です',
  intakeTimeout: 'intake ポップアップが 180 秒でタイムアウトしました。回答は記録されていません',
  goal: '目標',
  assumptions: '前提',
  openQuestions: '未確認事項',
}

const es: ToolCopy = {
  readReason: 'La toma de lectura de archivos está activa. Usa AMP workspace.list, workspace.outline y workspace.read con startLine/endLine o un rango de bytes. La lectura nativa está desactivada.',
  writeReason: 'La toma de escritura de archivos está activa. Usa AMP workspace.write o workspace.replace con expectedBaseHash/expectedBufferVersion. La escritura nativa está desactivada.',
  searchReason: 'La toma de búsqueda está activa. Usa attention_manifest_protocol_discover con action="search", revisa el esquema y lee solo los rangos relevantes. glob/grep nativos están desactivados.',
  proposalHeader: 'Enfoque',
  proposalQuestion: 'Elige un enfoque',
  invalidIntake: 'Argumentos de intake no válidos',
  intakeTimeout: 'La ventana de intake agotó 180 s; no se registró ninguna respuesta',
  goal: 'Objetivo',
  assumptions: 'Supuestos',
  openQuestions: 'Preguntas abiertas',
}

const fr: ToolCopy = {
  readReason: 'La reprise de lecture de fichiers est active. Utilisez AMP workspace.list, workspace.outline puis workspace.read avec startLine/endLine ou une plage d’octets. La lecture native est désactivée.',
  writeReason: 'La reprise d’écriture de fichiers est active. Utilisez AMP workspace.write ou workspace.replace avec expectedBaseHash/expectedBufferVersion. L’écriture native est désactivée.',
  searchReason: 'La reprise de recherche est active. Utilisez attention_manifest_protocol_discover avec action="search", consultez le plan puis lisez uniquement les plages utiles. glob/grep natifs sont désactivés.',
  proposalHeader: 'Approche',
  proposalQuestion: 'Choisir une approche',
  invalidIntake: 'Arguments intake invalides',
  intakeTimeout: 'La fenêtre intake a expiré après 180 s ; aucune réponse enregistrée',
  goal: 'Objectif',
  assumptions: 'Hypothèses',
  openQuestions: 'Questions ouvertes',
}

const de: ToolCopy = {
  readReason: 'Die Datei-Leseübernahme ist aktiv. Verwende AMP workspace.list, workspace.outline und dann workspace.read mit startLine/endLine oder einem Bytebereich. Das native read ist deaktiviert.',
  writeReason: 'Die Datei-Schreibübernahme ist aktiv. Verwende AMP workspace.write oder workspace.replace mit expectedBaseHash/expectedBufferVersion. Native write/replace sind deaktiviert.',
  searchReason: 'Die Suchübernahme ist aktiv. Verwende attention_manifest_protocol_discover mit action="search", prüfe die Gliederung und lies nur die relevanten Bereiche. Native glob/grep sind deaktiviert.',
  proposalHeader: 'Ansatz',
  proposalQuestion: 'Ansatz wählen',
  invalidIntake: 'Ungültige intake-Argumente',
  intakeTimeout: 'intake-Fenster nach 180 s abgelaufen; keine Antwort aufgezeichnet',
  goal: 'Ziel',
  assumptions: 'Annahmen',
  openQuestions: 'Offene Fragen',
}

const ru: ToolCopy = {
  readReason: 'Перехват чтения файлов включён. Используйте AMP workspace.list, workspace.outline, затем workspace.read с startLine/endLine или диапазоном байт. Нативный read отключён.',
  writeReason: 'Перехват записи файлов включён. Используйте AMP workspace.write или workspace.replace с expectedBaseHash/expectedBufferVersion. Нативные write/replace отключены.',
  searchReason: 'Перехват поиска включён. Используйте attention_manifest_protocol_discover с action="search", проверьте структуру и читайте только нужные диапазоны. Нативные glob/grep отключены.',
  proposalHeader: 'Подход',
  proposalQuestion: 'Выберите подход',
  invalidIntake: 'Недопустимые аргументы intake',
  intakeTimeout: 'окно intake истекло через 180 с; ответ не записан',
  goal: 'Цель',
  assumptions: 'Допущения',
  openQuestions: 'Открытые вопросы',
}

const pt: ToolCopy = {
  readReason: 'A tomada de leitura de arquivos está ativa. Use AMP workspace.list, workspace.outline e workspace.read com startLine/endLine ou intervalo de bytes. O read nativo está desativado.',
  writeReason: 'A tomada de escrita de arquivos está ativa. Use AMP workspace.write ou workspace.replace com expectedBaseHash/expectedBufferVersion. write/replace nativos estão desativados.',
  searchReason: 'A tomada de busca está ativa. Use attention_manifest_protocol_discover com action="search", revise o esboço e leia apenas os intervalos relevantes. glob/grep nativos estão desativados.',
  proposalHeader: 'Abordagem',
  proposalQuestion: 'Escolha uma abordagem',
  invalidIntake: 'Argumentos de intake inválidos',
  intakeTimeout: 'A janela de intake expirou após 180 s; nenhuma resposta foi registrada',
  goal: 'Objetivo',
  assumptions: 'Premissas',
  openQuestions: 'Questões em aberto',
}

const TABLES: Record<Locale, ToolCopy> = { zh, en, ja, es, fr, de, ru, pt }

/** Resolve host copy through the shipped locale table, falling back to English. */
export function toolCopy(locale: string | undefined): ToolCopy {
  return TABLES[normaliseLocale(locale)] ?? en
}
