/**
 * Bounded transcript window: the render-cost governor for long Sessions.
 *
 * Chat mounts one stable seat per Conversation Node and keeps it mounted while
 * a Turn-process disclosure hides it, so a long-running Session's React tree
 * and DOM both grow with the whole loaded window. That is O(nodes) work per
 * render — and the retained element tree is O(nodes) memory — for content the
 * reader cannot see.
 *
 * This module projects the loaded `order` onto a fixed budget: the newest
 * `windowTurns` Turns keep their seats, and every older Turn collapses into one
 * closed-able fold row. The projection is pure so the seat list can be derived
 * during render, and the retained-seat count no longer depends on Session
 * length.
 */

/** Default number of newest Turns that keep individually mounted seats. */
export const DEFAULT_WINDOW_TURNS = 5

/** Page step the fold row raises the window by, in Turns. */
export const TRANSCRIPT_WINDOW_PAGE_STEP = DEFAULT_WINDOW_TURNS

/**
 * Hard cap on the raised window, in pages. Revealing is a convenience, not an
 * escape hatch: the mount budget must stay bounded even when the reader keeps
 * asking for more, so the oldest Turns eventually become `Load earlier`.
 */
export const TRANSCRIPT_WINDOW_PAGE_CAP = 8

/** Stable key of the synthetic fold row standing in for earlier Turns. */
export const TRANSCRIPT_FOLD_KEY = '\u0000transcript-fold'

/** One collapsed stretch of Turns replaced by the fold row. */
export interface TranscriptFoldGroup {
  /** Turns represented by the fold row, ascending. */
  readonly turns: readonly number[]
  /** Total Session nodes those Turns own in the loaded window. */
  readonly nodeCount: number
}

/** Render projection of the loaded order under a Turn budget. */
export interface TranscriptWindow {
  /** Keys to seat individually, in loaded order. */
  readonly retained: readonly string[]
  /** Earlier Turns replaced by the fold row, or null when nothing folded. */
  readonly fold: TranscriptFoldGroup | null
  /** Session sections before the window head, in loaded order. */
  readonly leading: readonly string[]
  /** Every Turn present in the loaded order, ascending. */
  readonly turns: readonly number[]
}

/**
 * Pages needed for the window to own `target`'s Turn.
 * The fold row's reveal is a render decision, so navigation can raise the
 * budget by the same step instead of jumping to a row that is not mounted.
 * @param turns - loaded Turns, ascending, as reported by the projection.
 * @param target - Turn the reader is navigating to.
 * @param pageTurns - Turns per page.
 * @returns page count clamped to the reveal cap, or 1 when `target` is unknown.
 */
export function pagesToRevealTurn(
  turns: readonly number[],
  target: number,
  pageTurns: number = TRANSCRIPT_WINDOW_PAGE_STEP,
): number {
  const rank = turns.indexOf(target)
  if (rank < 0 || pageTurns <= 0) return 1
  // Keep the target plus everything newer: the window is a suffix.
  const need = Math.ceil((turns.length - rank) / pageTurns)
  return Math.min(TRANSCRIPT_WINDOW_PAGE_CAP, Math.max(1, need))
}

/**
 * Project the loaded order onto a bounded Turn window.
 *
 * Rows that resolve to no Turn (session-section nodes at the very head) always
 * stay: they are a fixed handful of leading rows, not a per-Turn cost, and
 * dropping the System-prompt row would change what the transcript shows.
 *
 * @param order - loaded Conversation Node keys in render order.
 * @param turnOf - resolves one node key to its owning Turn, or null.
 * @param windowTurns - newest Turns that keep their own seats.
 * @returns retained keys, the fold summary, and leading section keys.
 */
export function projectTranscriptWindow(
  order: readonly string[],
  turnOf: (key: string) => number | null,
  windowTurns: number = DEFAULT_WINDOW_TURNS,
): TranscriptWindow {
  const turnsSeen = new Set<number>()
  for (const key of order) {
    const turn = turnOf(key)
    if (turn !== null) turnsSeen.add(turn)
  }
  const budget = Number.isFinite(windowTurns) ? Math.max(0, Math.trunc(windowTurns)) : DEFAULT_WINDOW_TURNS
  // A zero budget must fold every Turn, so only a Session inside a positive
  // budget (or one with no Turns at all) keeps its rows unconditionally.
  if (turnsSeen.size === 0 || turnsSeen.size <= budget) {
    return { retained: order, fold: null, leading: [], turns: [...turnsSeen] }
  }

  const turns = [...turnsSeen].sort((left, right) => left - right)
  // Loaded order ascends by Turn, so the folded Turns are already the head of
  // the sorted list; no second pass is needed to name them.
  const foldedTurns = turns.slice(0, turns.length - budget)
  const foldTurns = new Set(foldedTurns)
  // A row that owns no Turn belongs to no folded Turn either; it stays only
  // while it precedes the window head, so trailing Turn-less rows never get
  // dropped between two seated Turns.
  let head = order.findIndex((key) => {
    const turn = turnOf(key)
    return turn !== null && !foldTurns.has(turn)
  })
  if (head < 0) head = order.length

  const retained: string[] = []
  const leading: string[] = []
  let nodeCount = 0
  for (const [index, key] of order.entries()) {
    if (index >= head) {
      // Everything from the window head on is seated; the projection is one
      // contiguous suffix, so the retained run is the tail of the order.
      retained.push(key)
      continue
    }
    if (turnOf(key) === null) leading.push(key)
    else nodeCount += 1
  }
  return {
    retained,
    fold: { turns: foldedTurns, nodeCount },
    leading,
    turns,
  }
}
