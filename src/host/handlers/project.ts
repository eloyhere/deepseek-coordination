/** AMP project verbs: metadata, rules and a CAS-guarded environment file. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { AMP_PREFIX } from '../names.js'
import { ensureStoreIgnored } from '../vcsIgnore.js'
import { takeProjectOutline } from '../readNavigation.js'
import type { AmpHost } from '../amp.js'
import { failure, objectArg, ok, rootOf } from './shared.js'
import type { HandlerMap, Params } from './shared.js'

function key(module: string, verb: string): string {
  return `${AMP_PREFIX}_${module}.${verb}`
}

interface ProjectFile {
  version: number
  environment: {
    variables: Record<string, string>
    paths: string[]
    dependencies: Record<string, string>
  }
  rules: Array<{ id: string; text: string; version: number }>
}

const EMPTY: ProjectFile = {
  version: 0,
  environment: { variables: {}, paths: [], dependencies: {} },
  rules: [],
}

function fileOf(host: AmpHost): string {
  return join(resolve(rootOf(host)), '.deepseek-coordination', 'project.json')
}

function readProject(host: AmpHost): ProjectFile {
  const file = fileOf(host)
  if (!existsSync(file)) return structuredClone(EMPTY)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectFile>
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 0,
      environment: {
        variables: typeof parsed.environment?.variables === 'object' && parsed.environment.variables !== null ? parsed.environment.variables : {},
        paths: Array.isArray(parsed.environment?.paths) ? parsed.environment.paths.filter((path): path is string => typeof path === 'string') : [],
        dependencies: typeof parsed.environment?.dependencies === 'object' && parsed.environment.dependencies !== null ? parsed.environment.dependencies : {},
      },
      rules: Array.isArray(parsed.rules)
        ? parsed.rules.filter((rule): rule is ProjectFile['rules'][number] => typeof rule === 'object' && rule !== null && typeof (rule as { id?: unknown }).id === 'string')
        : [],
    }
  } catch {
    return structuredClone(EMPTY)
  }
}

function writeProject(host: AmpHost, project: ProjectFile): void {
  const file = fileOf(host)
  mkdirSync(dirname(file), { recursive: true })
  ensureStoreIgnored(resolve(rootOf(host)), dirname(file))
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(project, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

function packageMetadata(host: AmpHost): Record<string, unknown> {
  const root = resolve(rootOf(host))
  const file = join(root, 'package.json')
  let pkg: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    } catch {
      pkg = {}
    }
  }
  return {
    root,
    name: typeof pkg.name === 'string' ? pkg.name : root.split(/[\\/]/).pop(),
    version: typeof pkg.version === 'string' ? pkg.version : null,
    description: typeof pkg.description === 'string' ? pkg.description : null,
    private: pkg.private === true,
  }
}

export function projectHandlers(host: AmpHost): HandlerMap {
  return {
    [key('project', 'metadata')]: () => {
      const project = takeProjectOutline(host, rootOf(host))
      return project === undefined
        ? ok(packageMetadata(host))
        : ok({ phase: 'project_outline', project, next: { verb: 'metadata', arguments: {} }, note: 'Project outline delivered. Repeat metadata to retrieve project details.' })
    },

    [key('project', 'rules')]: () => {
      const project = readProject(host)
      return ok({ version: project.version, rules: project.rules })
    },

    [key('project', 'environment')]: () => {
      const project = readProject(host)
      return ok({ version: project.version, environment: project.environment })
    },

    [key('project', 'describe_environment')]: () => {
      const outline = takeProjectOutline(host, rootOf(host))
      if (outline !== undefined) {
        return ok({ phase: 'project_outline', project: outline, next: { verb: 'describe_environment', arguments: {} }, note: 'Project outline delivered. Repeat describe_environment to retrieve project details.' })
      }
      const project = readProject(host)
      const gaps: string[] = []
      if (Object.keys(project.environment.variables).length === 0) gaps.push('no environment variables declared')
      if (project.environment.paths.length === 0) gaps.push('no project paths declared')
      if (Object.keys(project.environment.dependencies).length === 0) gaps.push('no dependencies declared')
      return ok({
        version: project.version,
        environment: project.environment,
        gaps,
        complete: gaps.length === 0,
        metadata: packageMetadata(host),
      })
    },

    [key('project', 'configure_environment')]: (parameters: Params) => {
      const project = readProject(host)
      const expected = typeof parameters.expectedVersion === 'number' ? parameters.expectedVersion : undefined
      if (expected !== undefined && expected !== project.version) {
        return failure('version_conflict', `expectedVersion ${expected} does not match ${project.version}`)
      }
      const patch = objectArg(parameters.patch ?? parameters.environment, 'patch')
      const next: ProjectFile = {
        version: project.version + 1,
        environment: {
          variables: { ...project.environment.variables },
          paths: [...project.environment.paths],
          dependencies: { ...project.environment.dependencies },
        },
        rules: project.rules,
      }
      if (patch.variables !== undefined) {
        const variables = objectArg(patch.variables, 'patch.variables')
        for (const [name, value] of Object.entries(variables)) next.environment.variables[name] = String(value)
      }
      if (patch.paths !== undefined) {
        if (!Array.isArray(patch.paths)) return failure('invalid_arguments', 'patch.paths must be an array')
        next.environment.paths = patch.paths.filter((path): path is string => typeof path === 'string')
      }
      if (patch.dependencies !== undefined) {
        const dependencies = objectArg(patch.dependencies, 'patch.dependencies')
        for (const [name, value] of Object.entries(dependencies)) next.environment.dependencies[name] = String(value)
      }
      if (parameters.dryRun === true) return ok({ version: next.version, environment: next.environment, dryRun: true })
      writeProject(host, next)
      return ok({ version: next.version, environment: next.environment })
    },

    [key('project', 'put_rule')]: (parameters: Params) => {
      const project = readProject(host)
      const id = typeof parameters.id === 'string' && parameters.id.trim().length > 0
        ? parameters.id.trim()
        : `rule-${project.rules.length + 1}`
      const text = parameters.text ?? parameters.rule
      if (typeof text !== 'string' || text.trim().length === 0) return failure('invalid_arguments', 'text is required')
      const existing = project.rules.find((rule) => rule.id === id)
      const expected = typeof parameters.expectedVersion === 'number' ? parameters.expectedVersion : undefined
      if (existing !== undefined && expected !== undefined && expected !== existing.version) {
        return failure('version_conflict', `expectedVersion ${expected} does not match ${existing.version}`)
      }
      const version = (existing?.version ?? 0) + 1
      const rules = project.rules.filter((rule) => rule.id !== id)
      rules.push({ id, text: text.trim(), version })
      const next: ProjectFile = { ...project, version: project.version + 1, rules }
      writeProject(host, next)
      return ok({ id, version, projectVersion: next.version })
    },
  }
}

