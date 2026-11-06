/**
 * `mind_update` rewrites the near-term state and, optionally, one bond.
 *
 * Omitted fields stay as they are. A group bond needs `peer_id`; a private
 * chat defaults the peer to the person in the room.
 *
 * @module dsn-mnemo/tools/mind-update
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DatabaseSync } from 'node:sqlite'
import { upsertBond } from '../store/bond-store.js'
import { markMindWritten } from '../store/ledger-store.js'
import { currentScene } from '../store/message-store.js'
import { upsertMindState } from '../store/state-store.js'

function clamp01(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

/** Build the registry-ready `mind_update` tool bound to one database. */
export function createMindUpdateTool(db: DatabaseSync) {
  return defineTool({
    name: 'mind_update',
    description:
      '更新此刻的心情、精力和还挂着的事，也可以改和某个人的关系笔记。只写有变化的字段。没有变化就别调用。',
    parameters: {
      mood: { type: 'string', description: '此刻心情，短句。' },
      energy: { type: 'string', description: '精力，短句。' },
      unresolved: { type: 'string', description: '还挂着、没了结的事。' },
      peer_id: { type: 'string', description: '关系对象。私聊可省略；群里是群友的 QQ。' },
      label: { type: 'string', description: '对这个人的称呼。' },
      notes: { type: 'string', description: '相处笔记。' },
      temperature: { type: 'number', description: '亲近程度，0 到 1。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          subject_kind: { type: 'string' },
          subject_id: { type: 'string' },
          state: { type: 'boolean' },
          bond: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: 'text', text: `mind ${value.subject_kind}:${value.subject_id} updated` },
      ],
    },
    async execute(args, exec) {
      const wantsState = args.mood !== undefined || args.energy !== undefined || args.unresolved !== undefined
      const wantsBond =
        args.peer_id !== undefined ||
        args.label !== undefined ||
        args.notes !== undefined ||
        args.temperature !== undefined
      if (!wantsState && !wantsBond) throw new Error('没有要更新的内容。')

      const sessionId = exec.agent?.session.id
      if (sessionId === undefined) throw new Error('还不知道这是谁的会话，没有更新。')
      const subject = currentScene(db, sessionId, exec.agent?.session.deriveMessages?.() ?? [])
      let peerId = (args.peer_id ?? '').trim()
      if (wantsBond && peerId.length === 0) {
        if (subject.kind !== 'user') throw new Error('群里要写关系，需要对方的号码。')
        peerId = subject.id
      }

      if (wantsState) {
        upsertMindState(db, {
          subject,
          ...(args.mood !== undefined ? { mood: args.mood.trim() } : {}),
          ...(args.energy !== undefined ? { energy: args.energy.trim() } : {}),
          ...(args.unresolved !== undefined ? { unresolved: args.unresolved.trim() } : {}),
        })
      }

      let wroteBond = false
      if (wantsBond) {
        const temperature = clamp01(args.temperature)
        upsertBond(db, {
          subject,
          peerId,
          ...(args.label !== undefined ? { label: args.label.trim() } : {}),
          ...(args.notes !== undefined ? { notes: args.notes.trim() } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
        })
        wroteBond = true
      }

      markMindWritten(db, subject)
      return { subject_kind: subject.kind, subject_id: subject.id, state: wantsState, bond: wroteBond }
    },
  })
}
