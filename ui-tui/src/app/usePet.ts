import { useCallback, useEffect, useRef, useState } from 'react'

import type { PetGrid } from '../components/petSprite.js'

import { useGateway } from './gatewayContext.js'
import { $turnState } from './turnStore.js'
import { $uiState } from './uiStore.js'

export type PetState = 'idle' | 'wave' | 'run' | 'failed' | 'review' | 'jump'

interface PetActivity {
  busy: boolean
  toolRunning: boolean
  reasoning: boolean
}

/**
 * Resolve the animation state — mirrors `agent.pet.state.derive_pet_state`
 * (and the desktop's `derivePetState`) so all surfaces agree.
 */
export function derivePetState({ busy, toolRunning, reasoning }: PetActivity): PetState {
  if (toolRunning) {
    return 'run'
  }

  if (reasoning) {
    return 'review'
  }

  if (busy) {
    return 'run'
  }

  return 'idle'
}

interface PetCellsResult {
  enabled?: boolean
  frameMs?: number
  frames?: PetGrid[]
  slug?: string
  state?: string
}

const FRAME_MS = 160
const POLL_MS = 2500

/**
 * Drives the TUI pet: derives the live state from the turn/ui stores, fetches
 * each (slug, state)'s half-block frames via the `pet.cells` RPC (cached), and
 * animates the frame index. Returns the grid to paint, or null when no pet is
 * enabled/installed.
 *
 * A steady `pet.cells` poll keeps it reactive to config changes made elsewhere
 * — `/pet`, the picker, `hermes pets select` — so adopting, switching, or
 * disabling a pet takes effect live (no restart). The frame cache is keyed by
 * slug so a switch re-pulls the new sprite instead of showing the old one.
 */
export function usePet(): { enabled: boolean; grid: PetGrid | null } {
  const { rpc } = useGateway()
  const [enabled, setEnabled] = useState(false)
  const [grid, setGrid] = useState<PetGrid | null>(null)

  const cache = useRef<Map<string, { frameMs: number; frames: PetGrid[] }>>(new Map())
  const slugRef = useRef('')
  const stateRef = useRef<PetState>('idle')
  const frameRef = useRef(0)

  const [petState, setPetState] = useState<PetState>('idle')

  // Recompute the desired state on every turn/ui change.
  useEffect(() => {
    const recompute = () => {
      const turn = $turnState.get()
      const ui = $uiState.get()

      const next = derivePetState({
        busy: ui.busy,
        toolRunning: turn.tools.length > 0,
        reasoning: turn.reasoningActive
      })

      if (next !== stateRef.current) {
        stateRef.current = next
        frameRef.current = 0
        setPetState(next)
      }
    }

    recompute()
    const unsubTurn = $turnState.listen(recompute)
    const unsubUi = $uiState.listen(recompute)

    return () => {
      unsubTurn()
      unsubUi()
    }
  }, [])

  // Fetch + cache one (slug, state). `pet.cells` resolves the active pet from
  // config, so its `slug`/`enabled` are the source of truth: a changed slug
  // invalidates the cache, a disabled pet clears everything.
  const sync = useCallback(
    async (state: PetState) => {
      try {
        const res = (await rpc('pet.cells', { state })) as PetCellsResult | null

        if (!res) {
          return
        }

        if (!res.enabled) {
          slugRef.current = ''
          cache.current.clear()
          setGrid(null)
          setEnabled(false)

          return
        }

        const slug = res.slug ?? ''

        if (slug !== slugRef.current) {
          slugRef.current = slug
          cache.current.clear()
          frameRef.current = 0
        }

        if (res.frames?.length) {
          cache.current.set(`${slug}:${state}`, { frameMs: res.frameMs ?? FRAME_MS, frames: res.frames })
        }

        setEnabled(true)
      } catch {
        // cosmetic — ignore RPC failures
      }
    },
    [rpc]
  )

  // Pull frames whenever the state changes (if not already cached for the
  // active pet), plus a steady poll that catches adopt/switch/disable.
  useEffect(() => {
    if (!cache.current.has(`${slugRef.current}:${petState}`)) {
      void sync(petState)
    }

    const timer = setInterval(() => void sync(stateRef.current), POLL_MS)

    return () => clearInterval(timer)
  }, [petState, sync])

  // Animation timer.
  useEffect(() => {
    if (!enabled) {
      return
    }

    const tick = () => {
      const entry = cache.current.get(`${slugRef.current}:${stateRef.current}`)

      if (!entry?.frames.length) {
        return // keep the last frame painted while the new state loads
      }

      const idx = frameRef.current % entry.frames.length
      setGrid(entry.frames[idx] ?? null)
      frameRef.current = idx + 1
    }

    tick()
    const interval = setInterval(tick, FRAME_MS)

    return () => clearInterval(interval)
  }, [enabled, petState])

  return { enabled, grid }
}
