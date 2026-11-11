/**
 * AMP cooperation kernel for the host mailbox.
 *
 * The mailbox is a real AMP cooperation: one star cooperation per session, one
 * delegated mailbox task, and every message stored through the coordinator so
 * it carries provenance and an owning cooperation instead of living in an
 * anonymous host map.
 */
import { randomUUID } from 'node:crypto'

import { CooperationCoordinator } from 'attention-manifest-protocol/cooperation'
import type { CooperationMessage, CooperationProtocol } from 'attention-manifest-protocol/cooperation'
import type { PermissionScope } from 'attention-manifest-protocol/profession'

const MAILBOX_SCOPE: PermissionScope = {
  capabilityIds: ['amp.*'],
  operations: ['send', 'report_result', 'inbox'],
  resources: ['workspace'],
  allowWrite: true,
}

function protocolFor(sessionId: string): CooperationProtocol {
  return {
    goal: { alignment: 'single', revisionPolicy: 'locked' },
    roles: {
      // AMP requires every role assignment and the arbiter to be a participant.
      assignments: [
        { agentId: sessionId, role: 'coordinator', responsibilities: ['own the session mailbox'] },
        { agentId: 'amp.mailbox', role: 'worker', responsibilities: ['receive stored messages'] },
      ],
      requireDistinctArbiter: false,
    },
    messages: {
      format: 'json',
      channel: 'host-mailbox',
      timeoutMs: 600_000,
      retries: 0,
      ordering: 'fifo',
      idempotent: true,
    },
    timing: { sequencing: 'sequential' },
    conflicts: { arbiterAgentId: sessionId, escalation: ['cooperation'], requireReason: true },
    sharing: { isolation: 'shared_read', mergeStrategy: 'owner' },
    convergence: { strategy: 'owner_decision', partialCompletion: 'report' },
  }
}

export interface MailboxRef {
  readonly cooperationId: string
  readonly taskId: string
}

export class AmpCooperation {
  readonly coordinator: CooperationCoordinator
  private readonly sessions = new Map<string, MailboxRef>()
  private readonly now: () => string

  constructor(now: () => string = () => new Date().toISOString()) {
    this.now = now
    this.coordinator = new CooperationCoordinator(now)
  }

  /** Lazily creates the session's cooperation and mailbox task. */
  ensure(sessionId: string): MailboxRef {
    const cached = this.sessions.get(sessionId)
    if (cached !== undefined) return cached
    const cooperationId = `cooperation:${sessionId}`
    this.coordinator.create({
      id: cooperationId,
      name: `AMP mailbox ${sessionId}`,
      goal: { objective: 'host mailbox', successCriteria: ['messages stored with provenance'] },
      participants: [{ agentId: sessionId }, { agentId: 'amp.mailbox' }],
      topology: 'star',
      protocol: protocolFor(sessionId),
      isolation: 'shared_read',
    })
    const taskId = `task:${sessionId}:mailbox`
    this.coordinator.delegate({
      taskId,
      cooperationId,
      delegatorAgentId: sessionId,
      ownerAgentId: sessionId,
      parentScope: MAILBOX_SCOPE,
      requestedScope: MAILBOX_SCOPE,
    })
    const ref = { cooperationId, taskId }
    this.sessions.set(sessionId, ref)
    return ref
  }

  /** Stores one mailbox message; `to` is carried in the payload, not as a participant. */
  send(sessionId: string, input: { to: string | null; thread: string | null; content: unknown }): CooperationMessage {
    const ref = this.ensure(sessionId)
    return this.coordinator.storeMessage({
      messageId: `message:${randomUUID()}`,
      taskId: ref.taskId,
      cooperationId: ref.cooperationId,
      senderAgentId: sessionId,
      recipientAgentId: 'amp.mailbox',
      kind: 'untrustedData',
      payload: { to: input.to, thread: input.thread, content: input.content } as never,
      provenance: [],
      sentAt: this.now(),
    })
  }

  /** Messages stored for this session's cooperation, oldest first. */
  inbox(sessionId: string): readonly CooperationMessage[] {
    const ref = this.sessions.get(sessionId)
    if (ref === undefined) return []
    return this.coordinator.messagesFor(ref.cooperationId)
  }

  summary(): { cooperations: number; messages: number } {
    const cooperations = this.coordinator.listCooperations().length
    const messages = this.coordinator.listCooperations()
      .reduce((total, cooperation) => total + cooperation.messageIds.length, 0)
    return { cooperations, messages }
  }
}
