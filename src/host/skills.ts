/** AMP module skills registered through the native DSH skill registry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type { AmpHost } from './amp.js'
import { pickText, type Locale, type LocalizedText } from '../shared/i18n.js'

interface SkillSpec {
  readonly name: string
  /** Routing copy shown by the skill catalog; the active host language picks one entry. */
  readonly description: LocalizedText
  readonly modules: readonly string[]
}

const SKILLS: readonly SkillSpec[] = [
  {
    name: 'amp-session-turn',
    description: {
      zh: '读取 AMP 会话与回合，提交响应、汇报进度并请求澄清。',
      en: 'Read the AMP session and turn, respond, report progress and ask for clarification.',
      ja: 'AMP のセッションとターンを読み取り、応答・進捗報告・確認要求を行います。',
      es: 'Lee la sesión y el turno de AMP, responde, informa el progreso y solicita aclaraciones.',
      fr: 'Lire la session et le tour AMP, répondre, signaler la progression et demander des clarifications.',
      de: 'AMP-Sitzung und -Turn lesen, antworten, Fortschritt melden und um Klärung bitten.',
      ru: 'Читать сеанс и ход AMP, отвечать, сообщать о ходе работы и запрашивать уточнения.',
      pt: 'Ler a sessão e o turno do AMP, responder, reportar progresso e pedir esclarecimentos.',
    },
    modules: ['session', 'turn'],
  },
  {
    name: 'amp-intent-mission',
    description: {
      zh: '读取已捕获的意图与战略使命，并提交澄清。',
      en: 'Read captured intent and the strategic mission; submit clarifications.',
      ja: '取り込まれた意図と戦略的使命を読み取り、確認事項を提出します。',
      es: 'Lee la intención capturada y la misión estratégica; envía aclaraciones.',
      fr: "Lire l'intention capturée et la mission stratégique ; soumettre des clarifications.",
      de: 'Erfasste Absicht und strategische Mission lesen; Klärungen einreichen.',
      ru: 'Читать зафиксированное намерение и стратегическую миссию; отправлять уточнения.',
      pt: 'Ler a intenção capturada e a missão estratégica; enviar esclarecimentos.',
    },
    modules: ['intent', 'mission'],
  },
  {
    name: 'amp-goal-plan',
    description: {
      zh: '读取目标与计划，并提交草案计划供宿主审批。',
      en: 'Read goals and plans, and propose a draft plan for host approval.',
      ja: 'ゴールと計画を読み取り、ホストの承認用に計画草案を提出します。',
      es: 'Lee objetivos y planes, y propone un plan borrador para la aprobación del host.',
      fr: "Lire les objectifs et les plans, et proposer un projet de plan à l'approbation de l'hôte.",
      de: 'Ziele und Pläne lesen und einen Planentwurf zur Genehmigung durch den Host vorschlagen.',
      ru: 'Читать цели и планы и предлагать черновик плана на утверждение хоста.',
      pt: 'Ler metas e planos, e propor um plano rascunho para aprovação do host.',
    },
    modules: ['goal', 'plan'],
  },
  {
    name: 'amp-task-action',
    description: {
      zh: '读取就绪任务与动作尝试，并汇报任务进度。',
      en: 'Read ready tasks and action attempts, and report task progress.',
      ja: '準備完了のタスクとアクション試行を読み取り、タスクの進捗を報告します。',
      es: 'Lee tareas listas e intentos de acción, e informa el progreso de las tareas.',
      fr: "Lire les tâches prêtes et les tentatives d'action, et signaler la progression des tâches.",
      de: 'Bereite Aufgaben und Aktionsversuche lesen und den Aufgabenfortschritt melden.',
      ru: 'Читать готовые задачи и попытки действий и сообщать о ходе задач.',
      pt: 'Ler tarefas prontas e tentativas de ação, e reportar o progresso das tarefas.',
    },
    modules: ['task', 'action'],
  },
  {
    name: 'amp-attention-context',
    description: {
      zh: '编译回合上下文并请求焦点，不占用驻留权。',
      en: 'Compile the turn context and request focus without owning residency.',
      ja: 'ターンコンテキストを編成し、常駐権を持たずにフォーカスを要求します。',
      es: 'Compila el contexto del turno y solicita el foco sin poseer la residencia.',
      fr: 'Compiler le contexte du tour et demander le focus sans posséder la résidence.',
      de: 'Den Turn-Kontext zusammenstellen und Fokus anfordern, ohne die Residency zu besitzen.',
      ru: 'Собирать контекст хода и запрашивать фокус, не владея резидентностью.',
      pt: 'Compilar o contexto do turno e solicitar foco sem possuir a residência.',
    },
    modules: ['attention', 'budget'],
  },
  {
    name: 'amp-workspace',
    description: {
      zh: '在工作区根目录内列出、读取、生成大纲、比较并 CAS 写入文件。',
      en: 'List, read, outline, diff and CAS-write files inside the workspace root.',
      ja: 'ワークスペースルート内のファイルを一覧・読み取り・アウトライン・差分・CAS 書き込みします。',
      es: 'Lista, lee, esquematiza, compara y escribe con CAS archivos dentro de la raíz del espacio de trabajo.',
      fr: "Lister, lire, structurer, comparer et écrire en CAS les fichiers sous la racine de l'espace de travail.",
      de: 'Dateien innerhalb des Arbeitsbereichsstamms auflisten, lesen, gliedern, vergleichen und per CAS schreiben.',
      ru: 'Просматривать, читать, структурировать, сравнивать и записывать файлы (CAS) в корне рабочей области.',
      pt: 'Listar, ler, estruturar, comparar e gravar com CAS arquivos dentro da raiz do espaço de trabalho.',
    },
    modules: ['workspace'],
  },
  {
    name: 'amp-project',
    description: {
      zh: '读取项目元数据、规则与环境；应用受保护的环境补丁。',
      en: 'Read project metadata, rules and environment; apply guarded environment patches.',
      ja: 'プロジェクトのメタデータ・ルール・環境を読み取り、保護された環境パッチを適用します。',
      es: 'Lee metadatos, reglas y entorno del proyecto; aplica parches de entorno protegidos.',
      fr: "Lire les métadonnées, règles et l'environnement du projet ; appliquer des correctifs d'environnement protégés.",
      de: 'Projektmetadaten, Regeln und Umgebung lesen; geschützte Umgebungs-Patches anwenden.',
      ru: 'Читать метаданные, правила и окружение проекта; применять защищённые патчи окружения.',
      pt: 'Ler metadados, regras e ambiente do projeto; aplicar patches de ambiente protegidos.',
    },
    modules: ['project'],
  },
  {
    name: 'amp-execution',
    description: {
      zh: '查找并检查 DSH 工具，通过策略管线运行，并分页读取结果句柄。',
      en: 'Find and inspect DSH tools, run them through the policy pipeline, and page result handles.',
      ja: 'DSH ツールを検索・検査し、ポリシーパイプライン経由で実行し、結果ハンドルをページングします。',
      es: 'Busca e inspecciona herramientas DSH, las ejecuta por la canalización de políticas y pagina los controles de resultados.',
      fr: 'Rechercher et inspecter les outils DSH, les exécuter via le pipeline de politiques et paginer les handles de résultats.',
      de: 'DSH-Tools finden und prüfen, durch die Policy-Pipeline ausführen und Ergebnis-Handles seitenweise lesen.',
      ru: 'Находить и проверять инструменты DSH, запускать их через конвейер политик и постранично читать дескрипторы результатов.',
      pt: 'Encontrar e inspecionar ferramentas DSH, executá-las pelo pipeline de políticas e paginar os identificadores de resultados.',
    },
    modules: ['execution'],
  },
  {
    name: 'amp-evidence',
    description: {
      zh: '读取证据，并在回复中引用证据 ID。',
      en: 'Read evidence and cite evidence ids in a response.',
      ja: '証拠を読み取り、応答内で証拠 ID を引用します。',
      es: 'Lee evidencias y cita los ids de evidencia en una respuesta.',
      fr: 'Lire les preuves et citer les identifiants de preuve dans une réponse.',
      de: 'Belege lesen und Beleg-IDs in einer Antwort zitieren.',
      ru: 'Читать доказательства и ссылаться на их идентификаторы в ответе.',
      pt: 'Ler evidências e citar os ids de evidência numa resposta.',
    },
    modules: ['evidence'],
  },
  {
    name: 'amp-cooperation',
    description: {
      zh: '交换委托消息并提交委托结果。',
      en: 'Exchange delegated messages and report a delegated result.',
      ja: '委任メッセージを交換し、委任結果を報告します。',
      es: 'Intercambia mensajes delegados y reporta un resultado delegado.',
      fr: 'Échanger des messages délégués et signaler un résultat délégué.',
      de: 'Delegierte Nachrichten austauschen und ein delegiertes Ergebnis melden.',
      ru: 'Обмениваться делегированными сообщениями и сообщать делегированный результат.',
      pt: 'Trocar mensagens delegadas e reportar um resultado delegado.',
    },
    modules: ['cooperation'],
  },
]

const CALL_SHAPE: LocalizedText = {
  zh: '以 `{ "verb": "...", "arguments": { ... } }` 调用模块工具。',
  en: 'Call the module tool with `{ "verb": "...", "arguments": { ... } }`.',
  ja: 'モジュールツールを `{ "verb": "...", "arguments": { ... } }` で呼び出します。',
  es: 'Llama a la herramienta del módulo con `{ "verb": "...", "arguments": { ... } }`.',
  fr: "Appelez l'outil du module avec `{ \"verb\": \"...\", \"arguments\": { ... } }`.",
  de: 'Rufen Sie das Modultool mit `{ "verb": "...", "arguments": { ... } }` auf.',
  ru: 'Вызывайте инструмент модуля с `{ "verb": "...", "arguments": { ... } }`.',
  pt: 'Chame a ferramenta do módulo com `{ "verb": "...", "arguments": { ... } }`.',
}

const DISCOVER_HINT: LocalizedText = {
  zh: '使用 `attention_manifest_protocol_discover` 查看完整接口。',
  en: 'Use `attention_manifest_protocol_discover` for the full surface.',
  ja: '完全なサーフェスは `attention_manifest_protocol_discover` で確認できます。',
  es: 'Usa `attention_manifest_protocol_discover` para ver la superficie completa.',
  fr: 'Utilisez `attention_manifest_protocol_discover` pour la surface complète.',
  de: 'Nutzen Sie `attention_manifest_protocol_discover` für die vollständige Oberfläche.',
  ru: 'Используйте `attention_manifest_protocol_discover` для полного интерфейса.',
  pt: 'Use `attention_manifest_protocol_discover` para ver a superfície completa.',
}

function bodyFor(host: AmpHost, spec: SkillSpec, locale: Locale): string {
  const modules = host.modules.filter((module) => spec.modules.includes(module.module))
  const lines = modules.flatMap((module) => [
    `## ${module.module}`,
    '',
    module.summary,
    '',
    ...module.verbs.map((verb) => `- \`${verb.verb}\`${verb.mutating ? ' (mutating)' : ''}: ${verb.summary} [${verb.authority.join(', ')}]`),
    '',
  ])
  return [
    `# ${spec.name}`,
    '',
    pickText(spec.description, locale),
    '',
    pickText(CALL_SHAPE, locale),
    pickText(DISCOVER_HINT, locale),
    '',
    ...lines,
  ].join('\n')
}

/**
 * Register one skill per AMP module group in the active host language.
 * @returns the disposer that removes every skill this call registered.
 */
export function registerAmpSkills(ctx: Context, host: AmpHost, locale: Locale): () => void {
  const disposers: Array<() => void> = []
  for (const spec of SKILLS) {
    const modules = host.modules.filter((module) => spec.modules.includes(module.module))
    if (modules.length === 0) continue
    disposers.push(ctx.skills.register({
      name: spec.name,
      description: pickText(spec.description, locale),
      content: bodyFor(host, spec, locale),
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: 'deepseek-coordination',
    }))
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
