/**
 * Inject State + Bond into the dynamic context.
 *
 * `mind_update` and the group recorder write these rows. This module only
 * reads them, so an empty database stays silent.
 *
 * @module dsn-mnemo/inject/mind
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Session } from '@deepseek-ai/dsh-session'
import { getBond, listBonds, renderBonds } from '../store/bond-store.js'
import { sessionSubject, subjectFromMessages } from '../store/message-store.js'
import { getMindState, renderMindState } from '../store/state-store.js'

function peerIdsFromSession(session: Session): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const message of session.deriveMessages()) {
    const source = message.source as { userId?: string; groupId?: string } | undefined
    const userId = source?.userId
    if (typeof userId !== 'string' || userId.length === 0) continue
    if (seen.has(userId)) continue
    seen.add(userId)
    ids.push(userId)
  }
  return ids
}

/** Build the `mnemo:mind` context text for the current session. */
export function createMindText(db: DatabaseSync): (session: Session) => string {
  return (session) => {
    const subject = subjectFromMessages(session.deriveMessages()) ?? sessionSubject(db, session.id)
    const parts: string[] = []
    const stateLine = renderMindState(getMindState(db, subject))
    if (stateLine.length > 0) parts.push(stateLine)

    if (subject.kind === 'group') {
      const bonds = peerIdsFromSession(session)
        .map((peerId) => getBond(db, subject, peerId))
        .filter((bond): bond is NonNullable<typeof bond> => bond !== undefined)
      const block = renderBonds(bonds)
      if (block.length > 0) parts.push(block)
    } else {
      const block = renderBonds(listBonds(db, subject, 1))
      if (block.length > 0) parts.push(block)
    }

    return parts.join('\n')
  }
}
