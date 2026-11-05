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

/** Stable identity of the operator-owned fields. A change means the config file won. */
export function configFingerprint(state: Pick<PersonaState, 'ownerId' | 'addressUser' | 'activeId' | 'toggles'>): string {
  return JSON.stringify({
    ownerId: state.ownerId,
    addressUser: state.addressUser,
    activeId: state.activeId,
    toggles: state.toggles,
  })
}

function clone(state: PersonaState): PersonaState {
  return { ...state, toggles: { ...state.toggles } }
}

interface StoredState extends Partial<PersonaState> {
  configFingerprint?: string
}

function load(path: string, defaults: PersonaState): { state: PersonaState; fingerprint: string | undefined } {
  try {
    if (!existsSync(path)) return { state: clone(defaults), fingerprint: undefined }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredState
    return {
      state: {
        activeId: parsed.activeId ?? defaults.activeId,
        name: parsed.name ?? defaults.name,
        addressUser: parsed.addressUser ?? defaults.addressUser,
        custom: parsed.custom ?? defaults.custom,
        ownerId: parsed.ownerId ?? defaults.ownerId,
        addressPending: parsed.addressPending ?? defaults.addressPending,
        toggles: { ...defaults.toggles, ...(parsed.toggles ?? {}) },
      },
      fingerprint: typeof parsed.configFingerprint === 'string' ? parsed.configFingerprint : undefined,
    }
  } catch {
    return { state: clone(defaults), fingerprint: undefined }
  }
}

export function createStateStore(path: string, defaults: PersonaState, fingerprint?: string): StateStore {
  const loaded = load(path, defaults)
  let state = loaded.state
  if (fingerprint !== undefined && loaded.fingerprint !== undefined && loaded.fingerprint !== fingerprint) {
    state = {
      ...state,
      activeId: defaults.activeId,
      name: defaults.name,
      addressUser: defaults.addressUser,
      ownerId: defaults.ownerId,
      toggles: { ...defaults.toggles },
      addressPending: defaults.ownerId.length > 0 ? false : state.addressPending,
    }
  }

  const persist = (next: PersonaState): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const body = fingerprint === undefined ? next : { ...next, configFingerprint: fingerprint }
      writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    } catch {
      // Personalization is best-effort; a read-only home must not crash the bot.
    }
  }

  if (fingerprint !== undefined && loaded.fingerprint !== fingerprint) {
    persist(state)
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
