/**
 * Bounded transcript window: the render-cost governor for long Sessions.
 *
 * Chat seats one stable renderer per Conversation Node and keeps that subtree
 * mounted while a Turn-process disclosure hides it, so a long-running Session's
 * React tree and DOM both grow with the whole loaded window: O(loaded nodes)
 * work per render plus an O(loaded nodes) retained element tree, for content the
 * reader cannot see. Hiding is a paint decision, never a render one.
 *
 * This module projects the loaded entry sequence onto a fixed budget: the newest
 * `windowTurns` Turns keep their own seats, and every older Turn collapses into
 * one fold row that reports how much it stands for. The projection is pure, so
 * the flow can derive its seat list during render and the mounted row count
 * stops depending on how long the Session has run.
 */

/** Default number of newest Turns that keep individually mounted seats. */
export const DEFAULT_WINDOW_TURNS = 5

/** Page step the fold row raises the window by, in Turns. */
export const TRANSCRIPT_WINDOW_PAGE_STEP = DEFAULT_WINDOW_TURNS

/**
 * Hard cap on the raised window, in pages. Revealing is a convenience, not an
 * escape hatch: the mount budget must stay bounded even when the reader keeps
 * asking for more, so the oldest Turns eventually become the history pager's
 * business again.
 */
export const TRANSCRIPT_WINDOW_PAGE_CAP = 8

/** One collapsed stretch of Turns replaced by the fold row. */
export interface TranscriptFoldGroup {
  /** Turns represented by the fold row, ascending. */
  readonly turns: readonly number[]
  /** Entry count those Turns own in the loaded window. */
  readonly entries: number
}

/** Render projection of the loaded entries under a Turn budget. */
export interface TranscriptWindow<Entry> {
  /** Entries to seat individually, in loaded order: the contiguous suffix. */
  readonly retained: readonly Entry[]
  /** Earlier Turns replaced by the fold row, or null when nothing folded. */
  readonly fold: TranscriptFoldGroup | null
  /** Turn-less entries ahead of the window head, in loaded order. */
  readonly leading: readonly Entry[]
  /** Every Turn present in the loaded entries, ascending. */
  readonly turns: readonly number[]
}

/**
 * Pages needed for the window to own `target`'s Turn.
 * The fold row's reveal is a render decision, so navigation raises the budget by
 * the same step instead of jumping to a row that is not mounted.
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
 * Project the loaded entries onto a bounded Turn window.
 *
 * Entries that resolve to no Turn (session-scoped sections at the very head)
 * always stay: they are a fixed handful of leading rows, not a per-Turn cost,
 * and dropping the System-prompt row would change what the transcript shows.
 *
 * @param entries - loaded entries in render order.
 * @param turnOf - resolves one entry to its owning Turn, or null.
 * @param windowTurns - newest Turns that keep their own seats.
 * @returns retained entries, the fold summary, and leading Turn-less entries.
 */
export function projectTranscriptWindow<Entry>(
  entries: readonly Entry[],
  turnOf: (entry: Entry) => number | null,
  windowTurns: number = DEFAULT_WINDOW_TURNS,
): TranscriptWindow<Entry> {
  const turnsSeen = new Set<number>()
  for (const entry of entries) {
    const turn = turnOf(entry)
    if (turn !== null) turnsSeen.add(turn)
  }
  const budget = Number.isFinite(windowTurns) ? Math.max(0, Math.trunc(windowTurns)) : DEFAULT_WINDOW_TURNS
  // A zero budget must fold every Turn, so only a Session inside a positive
  // budget (or one with no Turns at all) keeps its rows unconditionally.
  if (turnsSeen.size === 0 || turnsSeen.size <= budget) {
    return { retained: entries, fold: null, leading: [], turns: [...turnsSeen] }
  }

  const turns = [...turnsSeen].sort((left, right) => left - right)
  // Loaded order ascends by Turn, so the folded Turns are the head of the
  // sorted list; no second pass is needed to name them.
  const foldedTurns = turns.slice(0, turns.length - budget)
  const foldTurns = new Set(foldedTurns)
  // A row that owns no Turn belongs to no folded Turn either; it stays only
  // while it precedes the window head, so a trailing Turn-less row never gets
  // dropped from between two seated Turns.
  let head = entries.findIndex((entry) => {
    const turn = turnOf(entry)
    return turn !== null && !foldTurns.has(turn)
  })
  if (head < 0) head = entries.length

  const retained: Entry[] = []
  const leading: Entry[] = []
  let folded = 0
  for (const [index, entry] of entries.entries()) {
    if (index >= head) {
      // Everything from the window head on is seated; the projection is one
      // contiguous suffix, so the retained run is the tail of the entries.
      retained.push(entry)
      continue
    }
    if (turnOf(entry) === null) leading.push(entry)
    else folded += 1
  }
  return {
    retained,
    fold: { turns: foldedTurns, entries: folded },
    leading,
    turns,
  }
}
