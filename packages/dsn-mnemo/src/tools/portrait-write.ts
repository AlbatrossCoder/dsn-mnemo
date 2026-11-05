/**
 * `portrait_write` rewrites the current long-term or short-term portrait.
 *
 * Over-long text is rejected and nothing is saved. A private chat can only
 * write that person's portrait. A group can only write the group or a member.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sessionSubject, subjectFromMessages } from '../store/message-store.js'
import { writePortrait, type PortraitKind } from '../store/portrait-store.js'

const BASE = { long: 120, short: 60 }
const OWNER = { long: 240, short: 120 }

export interface PortraitToolOptions {
  /** When non-empty, this id gets the doubled limit. Tests pass it in. */
  readonly ownerId?: string
  /** Whale-chat state file, read only when `ownerId` is empty. */
  readonly statePath?: string
}

function textLength(text: string): number {
  return Array.from(text).length
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function ownerFromFile(path: string): string {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { ownerId?: unknown }
    return typeof parsed.ownerId === 'string' ? parsed.ownerId : ''
  } catch {
    return ''
  }
}

function limitFor(part: 'long' | 'short', subjectId: string, ownerId: string): number {
  const doubled = ownerId.length > 0 && (subjectId === ownerId || subjectId.endsWith(`:${ownerId}`))
  return (doubled ? OWNER : BASE)[part]
}

export function createPortraitWriteTool(db: DatabaseSync, options: PortraitToolOptions = {}) {
  const statePath = expandHome(options.statePath ?? join(homedir(), '.dsh', 'whale-chat-state.json'))

  return defineTool({
    name: 'portrait_write',
    description:
      '写下或改掉当前的画像。长期和短期各一份，写多了就改这一份。超了字数写不进去，多出来的记进日记。私聊只写这个人，群里只写这个群或群友。',
    parameters: {
      target: {
        type: 'string',
        enum: ['person', 'group', 'member'],
        description: 'person 是私聊对象，group 是当前群，member 是当前群里的一个人。',
        required: true,
      },
      part: {
        type: 'string',
        enum: ['long', 'short'],
        description: 'long 是长期，short 是短期。',
        required: true,
      },
      content: {
        type: 'string',
        description: '这一份画像的全文。',
        required: true,
      },
      member_id: {
        type: 'string',
        description: 'target 为 member 时，这个群友的 QQ 号。',
      },
      label: {
        type: 'string',
        description: '用来在群消息里认出这个人的称呼。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          id: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `portrait ${value.kind} ${value.id} written` }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session.id
      const messages = exec.agent?.session.deriveMessages() ?? []
      const subject =
        sessionId === undefined ? undefined : (subjectFromMessages(messages) ?? sessionSubject(db, sessionId))
      if (subject === undefined) throw new Error('还不知道这是谁的会话，画像没有写入。')
      const target = args.target
      const part = args.part === 'short' ? 'short' : 'long'
      const content = args.content.trim()
      if (content.length === 0) throw new Error('画像是空的，没有写入。')

      let kind: PortraitKind
      let id: string
      if (subject.kind === 'group') {
        if (target === 'person') throw new Error('群里不写私聊画像。')
        if (target === 'group') {
          kind = 'group'
          id = subject.id
        } else {
          const memberId = (args.member_id ?? '').trim()
          if (memberId.length === 0) throw new Error('没有群友的号码，画像没有写入。')
          kind = 'member'
          id = `${subject.id}:${memberId}`
        }
      } else if (target === 'person') {
        kind = 'user'
        id = subject.id
      } else {
        throw new Error('私聊里不写群和群友的画像。')
      }

      const configured = options.ownerId?.trim() ?? ''
      const ownerId = configured.length > 0 ? configured : ownerFromFile(statePath)
      const limit = limitFor(part, id, ownerId)
      if (textLength(content) > limit) throw new Error('画像超了字数上限，没有写入。多出来的可以记进日记。')

      const label = args.label?.trim()
      writePortrait(db, {
        kind,
        id,
        part,
        content,
        ...(label === undefined || label.length === 0 ? {} : { label }),
      })
      return { kind, id }
    },
  })
}
