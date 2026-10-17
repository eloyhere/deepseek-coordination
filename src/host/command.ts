/**
 * The command face (v23 §6.4, §9.1, §9.7 ①).
 *
 * A command is a prefix on the user's message: `/goal 目标`, `/compact 摘要`, …
 * The prefix selects exactly one module and skips part of the pipeline; the
 * turn's `command` column caches the choice. This module only routes: it
 * records the command row, hands the remainder to the owning module's handler
 * and stores that handler's report. Business logic never lives here.
 *
 * Ten prefixes are accepted — five commands, each spelled in English and in
 * Chinese. A prefix matches only as a whole first token (followed by the end of
 * the message or whitespace), so `/tmp/foo`, `/goal/x` and `/goals` are
 * ordinary text, not commands.
 */
import type { Command, CommandResult, Turn } from '../shared/entity.js'
import type { CommandType } from '../shared/enum.js'
import { CommandValues } from '../shared/enum.js'
import { CoordinationError, InvalidArgumentError, InvalidStateError } from '../shared/error.js'
import type { ModuleHost } from './module.js'
import { mapCommand, mapTurn } from './row.js'
import type { Row } from './row.js'

const TERMINAL_TURN = new Set(['done', 'failed', 'cancelled', 'abandoned'])

/**
 * The ten accepted matching forms: a command name in English and in Chinese.
 * The keys are the exact, case-sensitive leading tokens of a message.
 */
export const COMMAND_PREFIX: Readonly<Record<string, CommandType>> = {
  '/goal': 'goal',
  '/目标': 'goal',
  '/plan': 'plan',
  '/计划': 'plan',
  '/feedback': 'feedback',
  '/反馈': 'feedback',
  '/compact': 'compact',
  '/压缩': 'compact',
  '/permission': 'permission',
  '/权限': 'permission',
}

/** The result of reading the command face off a message. */
export interface ParsedCommand {
  /** The routed command; `none` means "run the complete pipeline". */
  command: CommandType
  /** The message with the prefix removed, trimmed. The whole message when none. */
  content: string
  /** True only when a known prefix was matched; then `command !== 'none'`. */
  recognized: boolean
}

/** One module's handler. It receives the remainder and reports what it did. */
export interface CommandHandler {
  (turn: number, content: string): string | Promise<string>
}

/** One handler per command. `none` is not a command and has no handler. */
export interface CommandHandlers {
  goal: CommandHandler
  plan: CommandHandler
  feedback: CommandHandler
  compact: CommandHandler
  permission: CommandHandler
}

export class CommandModule {
  private readonly host: ModuleHost
  private readonly handlers: CommandHandlers

  constructor(host: ModuleHost, handlers: CommandHandlers) {
    this.host = host
    this.handlers = handlers
  }

  /**
   * Read the leading command prefix. Only a known prefix followed by the end of
   * the message or whitespace counts; anything else is `none` and the whole
   * message stays content. Leading whitespace before the prefix is tolerated.
   */
  parse(content: string): ParsedCommand {
    if (typeof content !== 'string') {
      throw new InvalidArgumentError('command content must be a string', { received: typeof content })
    }
    const trimmed = content.trim()
    if (trimmed.length === 0) return { command: 'none', content: '', recognized: false }

    const body = content.slice(content.length - content.trimStart().length)
    const whitespace = body.search(/\s/)
    const token = whitespace === -1 ? body : body.slice(0, whitespace)
    const command = Object.hasOwn(COMMAND_PREFIX, token)
      ? (COMMAND_PREFIX as Readonly<Record<string, CommandType | undefined>>)[token]
      : undefined
    if (command === undefined) return { command: 'none', content: trimmed, recognized: false }
    return {
      command,
      content: whitespace === -1 ? '' : body.slice(whitespace).trim(),
      recognized: true,
    }
  }

  /** Persist one command row; `finished` stays empty until it is executed. */
  record(turn: number, parsed: ParsedCommand): Command {
    const current = this.writableTurn(turn)
    const type: unknown = parsed?.command
    if (!CommandValues.includes(type as CommandType)) {
      throw new InvalidArgumentError(`unknown command type: ${String(type)}`, { allowed: CommandValues })
    }
    const commandType = type as CommandType
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    const created = this.host.clock.now()
    const identity = this.host.db.transaction(() => {
      const created_identity = this.host.db.insert('command', {
        handle: this.host.handles.next('command'),
        turn,
        type: commandType,
        content,
        created,
      })
      if (commandType !== 'none' && current.command !== commandType) {
        this.host.db.update('turn', { command: commandType }, 'identity = ?', turn)
      }
      return created_identity
    })
    return this.get(identity)
  }

  /** The latest command row of a turn, or `undefined` when it has none. */
  resolve(turn: number): Command | undefined {
    const row = this.host.db.get<Row>(
      'SELECT * FROM command WHERE turn = ? ORDER BY identity DESC LIMIT 1',
      turn,
    )
    return row === undefined ? undefined : mapCommand(row)
  }

  /** One command row by identity. */
  get(identity: number): Command {
    return mapCommand(this.host.db.require<Row>('command', identity, 'command'))
  }

  /**
   * Parse, record, hand the remainder to the owning module, then store the
   * handler's report. Domain state errors (missing turn, terminal turn) are
   * thrown; handler failures are reported in the row and in the result.
   *
   * `none` is a lawful outcome (the full pipeline), not a rejected command: it
   * is recorded and accepted without invoking a handler.
   */
  async execute(turn: number, content: string): Promise<CommandResult> {
    const parsed = this.parse(content)
    const command = this.record(turn, parsed)

    if (parsed.command === 'none') {
      const message = 'no command prefix; run the complete coordination pipeline'
      return { command: this.finish(command, message), action: 'accepted', message }
    }

    const handler = (this.handlers as Partial<Record<CommandType, CommandHandler>>)[parsed.command]
    if (typeof handler !== 'function') {
      const message = `no handler is registered for command "${parsed.command}"`
      return { command: this.finish(command, message), action: 'rejected', message }
    }

    try {
      const output = await handler(turn, parsed.content)
      const message = typeof output === 'string' ? output : String(output)
      return {
        command: this.finish(command, message),
        action: 'accepted',
        ...(message.length === 0 ? {} : { message }),
      }
    } catch (error) {
      const message = describeError(error)
      return { command: this.finish(command, message), action: 'rejected', message }
    }
  }

  private finish(command: Command, result: string): Command {
    this.host.db.update(
      'command',
      { result, finished: this.host.clock.now() },
      'identity = ?',
      command.identity,
    )
    return this.get(command.identity)
  }

  private writableTurn(turn: number): Turn {
    const current = mapTurn(this.host.db.require<Row>('turn', turn, 'turn'))
    if (TERMINAL_TURN.has(current.status)) {
      throw new InvalidStateError(`turn ${turn} is already ${current.status}`, {
        turn,
        status: current.status,
      })
    }
    return current
  }
}

/** Render a thrown value for the command result, keeping the typed error code. */
function describeError(error: unknown): string {
  if (error instanceof CoordinationError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  return String(error)
}
