/**
 * Runtime persona state: which persona is active, its toggles, and the
 * user-personalization layer (name / address / custom).
 *
 * Config supplies defaults; conversation-driven changes are persisted to a
 * small JSON file so they survive a restart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PersonaToggles } from './personas.js'

export interface PersonaState {
  activeId: string
  name: string
  addressUser: string
  custom: string
  /** QQ number of the claimed owner; empty means "not claimed yet". */
  ownerId: string
  /** The owner hasn't confirmed how they should be addressed yet. */
  addressPending: boolean
  toggles: PersonaToggles
}

export interface StateStore {
  get(): PersonaState
  update(patch: Partial<Omit<PersonaState, 'toggles'>> & { toggles?: Partial<PersonaToggles> }): PersonaState
  reset(): PersonaState
}

function clone(state: PersonaState): PersonaState {
  return { ...state, toggles: { ...state.toggles } }
}

function load(path: string, defaults: PersonaState): PersonaState {
  try {
    if (!existsSync(path)) return clone(defaults)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersonaState>
    return {
      activeId: parsed.activeId ?? defaults.activeId,
      name: parsed.name ?? defaults.name,
      addressUser: parsed.addressUser ?? defaults.addressUser,
      custom: parsed.custom ?? defaults.custom,
      ownerId: parsed.ownerId ?? defaults.ownerId,
      addressPending: parsed.addressPending ?? defaults.addressPending,
      toggles: { ...defaults.toggles, ...(parsed.toggles ?? {}) },
    }
  } catch {
    return clone(defaults)
  }
}

export function createStateStore(path: string, defaults: PersonaState): StateStore {
  let state = load(path, defaults)

  const persist = (next: PersonaState): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    } catch {
      // Personalization is best-effort; a read-only home must not crash the bot.
    }
  }

  const store: StateStore = {
    get: () => clone(state),
    update(patch) {
      state = {
        ...state,
        ...patch,
        toggles: { ...state.toggles, ...(patch.toggles ?? {}) },
      }
      persist(state)
      return clone(state)
    },
    reset() {
      state = clone(defaults)
      persist(state)
      return clone(state)
    },
  }
  return store
}
