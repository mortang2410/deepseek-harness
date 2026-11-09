import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_TURNS, TRANSCRIPT_WINDOW_PAGE_CAP, pagesToRevealTurn, projectTranscriptWindow,
} from '../src/client/chat/transcript-window.ts'

const N = DEFAULT_WINDOW_TURNS

/** `turns` Turns of `perTurn` synthetic entries each, plus a turn lookup. */
function orderOf(turns: number, perTurn = 2): { entries: readonly string[]; turnOf: (key: string) => number | null } {
  const entries: string[] = []
  const owner = new Map<string, number>()
  for (let turn = 0; turn < turns; turn += 1) {
    for (let row = 0; row < perTurn; row += 1) {
      const key = `t${String(turn)}/r${String(row)}`
      entries.push(key)
      owner.set(key, turn)
    }
  }
  return { entries, turnOf: key => owner.get(key) ?? null }
}

describe('transcript window projection', () => {
  it('keeps every entry while the Session fits the budget', () => {
    const { entries, turnOf } = orderOf(N, 3)
    const window = projectTranscriptWindow(entries, turnOf)
    expect(window.retained).toEqual(entries)
    expect(window.fold).toBeNull()
    expect(window.leading).toEqual([])
  })

  it('retains only the newest Turns and reports the folded span', () => {
    const turns = 20
    const { entries, turnOf } = orderOf(turns, 4)
    const window = projectTranscriptWindow(entries, turnOf)
    expect(window.fold?.turns).toEqual(Array.from({ length: turns - N }, (_, i) => i))
    // Folded entries are counted, never seated.
    expect(window.fold?.entries).toBe((turns - N) * 4)
    expect(window.retained.slice(-N * 4)).toEqual(entries.slice((turns - N) * 4))
    // Nothing outside the fold is dropped: fold + retained cover the whole list.
    expect(window.fold!.entries + window.retained.length).toBe(entries.length)
  })

  it('holds the mounted seat count constant as the Session grows', () => {
    const seats = [10, 100, 1_000].map(turns => projectTranscriptWindow(
      orderOf(turns, 5).entries, orderOf(turns, 5).turnOf,
    ).retained.length)
    expect(seats).toEqual([N * 5, N * 5, N * 5])
  })

  it('holds the mounted seat count constant at Session lengths a fixture cannot build', () => {
    // The projection's cost must not depend on how long the Session has run.
    const seats = [10_000, 100_000].map((turns) => {
      const { entries, turnOf } = orderOf(turns, 5)
      return projectTranscriptWindow(entries, turnOf).retained.length
    })
    expect(seats).toEqual([N * 5, N * 5])
  })

  it('keeps Turn-less leading entries and never drops a row between seated Turns', () => {
    const entries = ['session/sys', 't0/a', 't1/b', 't2/c', 't3/d', 't4/e', 't5/f', 't6/g', 'tail-less']
    const turnOf = (key: string): number | null => key === 'session/sys' || key === 'tail-less'
      ? null
      : Number(key.slice(1, key.indexOf('/')))
    const window = projectTranscriptWindow(entries, turnOf, 3)
    expect(window.leading).toEqual(['session/sys'])
    expect(window.retained).toEqual(['t4/e', 't5/f', 't6/g', 'tail-less'])
    expect(window.fold).toEqual({ turns: [0, 1, 2, 3], entries: 4 })
  })

  it('collapses everything for a zero budget and degrades safely on a bad one', () => {
    const { entries, turnOf } = orderOf(N + 4)
    const zero = projectTranscriptWindow(entries, turnOf, 0)
    expect(zero.retained).toEqual([])
    expect(zero.fold?.turns).toEqual(Array.from({ length: N + 4 }, (_, i) => i))
    // A non-finite budget falls back to the shipped default rather than folding all.
    expect(projectTranscriptWindow(entries, turnOf, Number.NaN).retained.length)
      .toBe(projectTranscriptWindow(entries, turnOf).retained.length)
  })
})

describe('pagesToRevealTurn', () => {
  const turns = Array.from({ length: 40 }, (_, i) => i)

  it('needs one page for the newest Turns and the cap for the oldest', () => {
    expect(pagesToRevealTurn(turns, 39)).toBe(1)
    expect(pagesToRevealTurn(turns, 35)).toBe(1)
    expect(pagesToRevealTurn(turns, 39 - N)).toBe(2)
    expect(pagesToRevealTurn(turns, 0)).toBe(TRANSCRIPT_WINDOW_PAGE_CAP)
  })

  it('falls back to one page for an unknown Turn or a bad step', () => {
    expect(pagesToRevealTurn(turns, 999)).toBe(1)
    expect(pagesToRevealTurn(turns, 0, 0)).toBe(1)
  })
})
