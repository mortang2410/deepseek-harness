import { describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ConversationNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import {
  DEFAULT_WINDOW_TURNS,
  TRANSCRIPT_FOLD_KEY,
  projectTranscriptWindow,
  type TranscriptWindow,
} from '../src/client/chat/transcript-window.ts'
import { zh } from '../src/client/locale.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

const N = DEFAULT_WINDOW_TURNS

/** One user+assistant pair per Turn, spread over `turns` Turns. */
function orderOf(turns: number, perTurn = 2): { order: readonly string[]; turnOf: (k: string) => number | null } {
  const nodes: ConversationNode[] = []
  const map = new Map<string, number>()
  for (let turn = 0; turn < turns; turn += 1) {
    for (let row = 0; row < perTurn; row += 1) {
      nodes.push({
        kind: 'user',
        seq: turn * 10 + row + 1,
        time: 1_000 * (turn * 10 + row),
        turn,
        content: [{ type: 'text', text: `turn ${String(turn)} row ${String(row)}` }],
        source: null,
      } as unknown as ConversationNode)
    }
  }
  const snapshot = chatSnapshotFixture({ nodes })
  for (const key of snapshot.order) {
    const location = snapshot.nodes.get(key)?.location
    if (location?.kind === 'turn' || location?.kind === 'step') {
      map.set(key, location.turn.turn)
    }
  }
  return { order: snapshot.order, turnOf: key => map.get(key) ?? null }
}

function project(turns: number, perTurn = 2): TranscriptWindow {
  const { order, turnOf } = orderOf(turns, perTurn)
  return projectTranscriptWindow(order, turnOf)
}

describe('transcript window projection', () => {
  it('keeps every row while the Session fits the budget', () => {
    const { order, turnOf } = orderOf(N, 3)
    const window = projectTranscriptWindow(order, turnOf)
    expect(window.retained).toEqual(order)
    expect(window.fold).toBeNull()
    expect(window.leading).toEqual([])
  })

  it('retains only the newest Turns and reports the folded span', () => {
    const { order, turnOf } = orderOf(20, 4)
    const window = projectTranscriptWindow(order, turnOf)
    expect(window.fold?.turns).toEqual(Array.from({ length: 20 - N }, (_, i) => i))
    // Folded rows are counted, never mounted.
    expect(window.fold?.nodeCount).toBe((20 - N) * 4)
    expect(window.retained.slice(-N * 4)).toEqual(order.slice((20 - N) * 4))
    // Nothing outside the fold is dropped: fold + retained cover the whole order.
    expect(window.fold!.nodeCount + window.retained.length).toBe(order.length)
  })

  it('holds the mounted seat count constant as the real Session grows', () => {
    // Fixture-built Sessions: the projection must agree with production
    // Location data, not just with synthetic keys.
    const sizes = [10, 100, 1_000]
    const seats = sizes.map(turns => project(turns, 5).retained.length)
    expect(seats).toEqual(sizes.map(() => N * 5))
    expect(new Set(seats).size).toBe(1)
  })

  it('holds the mounted seat count constant at Session lengths a fixture cannot build', () => {
    // Synthetic keys: the fixture path cannot build 10k Turns, and the
    // projection's cost must not depend on how long the Session has run.
    const seats = [10_000, 100_000].map((turns) => {
      const perTurn = 5
      const order: string[] = []
      for (let turn = 0; turn < turns; turn += 1) {
        for (let row = 0; row < perTurn; row += 1) order.push(`t${String(turn)}/r${String(row)}`)
      }
      const map = new Map(order.map(key => [key, Number(key.slice(1, key.indexOf('/')))]))
      const turnOf = (key: string): number => map.get(key)!
      return projectTranscriptWindow(order, turnOf).retained.length
    })
    expect(seats).toEqual([N * 5, N * 5])
  })

  it('keeps Turn-less leading rows and never drops a row between seated Turns', () => {
    const order = ['session/sys', 't0/a', 't1/b', 't2/c', 't3/d', 't4/e', 't5/f', 't6/g', 'tail-less']
    const turnOf = (key: string): number | null => key === 'session/sys' || key === 'tail-less'
      ? null
      : Number(key.slice(1, key.indexOf('/')))
    const window = projectTranscriptWindow(order, turnOf, 3)
    expect(window.leading).toEqual(['session/sys'])
    expect(window.retained).toEqual(['t4/e', 't5/f', 't6/g', 'tail-less'])
    expect(window.fold).toEqual({ turns: [0, 1, 2, 3], nodeCount: 4 })
  })

  it('collapses everything for a zero budget and degrades safely on a bad one', () => {
    expect(project(N + 4).retained.length).toBeGreaterThan(0)
    const { order, turnOf } = orderOf(N + 4)
    const zero = projectTranscriptWindow(order, turnOf, 0)
    expect(zero.retained).toEqual([])
    expect(zero.fold?.turns).toEqual(Array.from({ length: N + 4 }, (_, i) => i))
    // A non-finite budget falls back to the shipped default rather than folding all.
    expect(projectTranscriptWindow(order, turnOf, Number.NaN).retained.length).toBe(project(N + 4).retained.length)
  })

  it('exposes a fold key that cannot collide with a Conversation Node key', () => {
    expect(TRANSCRIPT_FOLD_KEY.startsWith('\u0000')).toBe(true)
    expect(orderOf(40).order).not.toContain(TRANSCRIPT_FOLD_KEY)
  })
})

describe('fold row copy', () => {
  it('is localized in both dictionaries', () => {
    expect(zh['chat.transcriptFolded']).toContain('{turns}')
    expect(makeTranslate(zh, commonZh)).toBeTypeOf('function')
  })
})
