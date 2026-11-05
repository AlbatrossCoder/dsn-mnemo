/**
 * Current portraits for this turn. Always injected, because a truncated
 * context cannot be told apart from a short one.
 *
 * A private chat carries that person. A group carries the group, the senders
 * of this turn who already have a portrait, and a familiar member only when
 * this turn's text mentions their label.
 */
import type { DatabaseSync } from 'node:sqlite'
import { sessionSubject, subjectFromMessages } from '../store/message-store.js'
import { listMemberPortraits, readPortrait, type Portrait } from '../store/portrait-store.js'

export interface PortraitSession {
  readonly id: string
  deriveMessages(): readonly unknown[]
}

interface SourcedMessage {
  readonly role?: unknown
  readonly content?: unknown
  readonly source?: { readonly kind?: unknown; readonly userId?: unknown }
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const value = block as { type?: unknown; text?: unknown }
    if (value.type === 'text' && typeof value.text === 'string') parts.push(value.text)
  }
  return parts.join('\n')
}

function turnMessages(messages: readonly unknown[]): SourcedMessage[] {
  const list = messages as readonly SourcedMessage[]
  let start = 0
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role === 'assistant') {
      start = index + 1
      break
    }
  }
  return list.slice(start)
}

function renderOne(title: string, portrait: Portrait): string {
  const lines = [`【${title}】`]
  if (portrait.longText.length > 0) lines.push(`长期：${portrait.longText}`)
  if (portrait.shortText.length > 0) lines.push(`短期：${portrait.shortText}`)
  return lines.length === 1 ? '' : lines.join('\n')
}

export function createPortraitText(db: DatabaseSync): (session: PortraitSession) => string {
  return (session) => {
    const messages = session.deriveMessages()
    const subject = subjectFromMessages(messages) ?? sessionSubject(db, session.id)
    if (subject.kind === 'user') {
      const portrait = readPortrait(db, 'user', subject.id)
      return portrait === undefined ? '' : renderOne('这个人', portrait)
    }

    const blocks: string[] = []
    const group = readPortrait(db, 'group', subject.id)
    if (group !== undefined) {
      const rendered = renderOne('这个群', group)
      if (rendered.length > 0) blocks.push(rendered)
    }

    const turn = turnMessages(messages)
    const speakers: string[] = []
    const texts: string[] = []
    for (const message of turn) {
      if (message.role !== 'user' || message.source?.kind !== 'qq') continue
      texts.push(textOf(message.content))
      const userId = message.source.userId
      if (typeof userId === 'string' && userId.length > 0 && !speakers.includes(userId)) speakers.push(userId)
    }
    const text = texts.join('\n')
    const members = listMemberPortraits(db, subject.id)
    const included = new Set<string>()

    for (const userId of speakers) {
      const portrait = members.find((item) => item.id === `${subject.id}:${userId}`)
      if (portrait === undefined) continue
      const rendered = renderOne(portrait.label.length > 0 ? portrait.label : userId, portrait)
      if (rendered.length === 0) continue
      blocks.push(rendered)
      included.add(portrait.id)
    }

    for (const portrait of members) {
      if (included.has(portrait.id)) continue
      const label = portrait.label.trim()
      if (Array.from(label).length < 2) continue
      if (!text.includes(label)) continue
      const rendered = renderOne(label, portrait)
      if (rendered.length > 0) blocks.push(rendered)
    }

    return blocks.join('\n')
  }
}
