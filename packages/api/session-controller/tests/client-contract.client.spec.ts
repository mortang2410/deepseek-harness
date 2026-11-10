import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { PromptContentPart as AttachmentPromptContentPart } from '@deepseek-ai/dsh-attachment/types'
import { SessionSeq, type SessionSeqCursor } from '@deepseek-ai/dsh-session/types'
import {
  MutableSessionEventSource, type SessionAssistantSettlementEntry,
  type SessionLiveEventEntry, type SessionTransientEventEntry,
} from '../src/client/contract/events.ts'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { ISession } from '../src/client/contract/session.ts'
import type { ProjectionsBaseline } from '../src/client/sessions/projection-store.ts'
import { ProjectionValueStore } from '../src/client/sessions/projection-store.ts'
import { retainSessionWindow, RETAINED_WINDOW_ENTRIES, RETAINED_WINDOW_TURNS } from '../src/client/sessions/session.ts'
import type { PromptContentPart as SessionPromptContentPart, SessionPageRequest } from '../src/types.ts'
import { ev, plainTurn } from './event-script.client.ts'

type RenameSuccess = Extract<Awaited<ReturnType<ISession['rename']>>, { readonly ok: true }>

function entry(seq: SessionSeq): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      type: 'turn/start',
      seq,
      time: seq,
      data: { turn: seq },
    },
  }
}

function transient(attemptId: string, seq = 1.5): SessionTransientEventEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time: 1,
      data: {
        attemptId: LlmAttemptId(attemptId),
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'live' },
      },
    },
  }
}

function assistantSettlement(seq: SessionSeq): SessionAssistantSettlementEntry {
  return {
    type: 'event',
    event: {
      type: 'assistant/attempt',
      seq,
      time: seq,
      data: { turn: 1, step: 1, stream: [] },
    },
  }
}

describe('Client Session contracts', () => {
  it('requires branded Session positions at internal event fixture boundaries', () => {
    expectTypeOf(entry).parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.user).parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.commandDone).parameter(4).toEqualTypeOf<SessionSeq | undefined>()
    expectTypeOf(ev.compactSummary).parameter(2).toEqualTypeOf<SessionSeq>()
    expectTypeOf(ev.compactCheckpoint).parameter(1).toEqualTypeOf<SessionSeq>()
    expectTypeOf(plainTurn).parameter(0).toEqualTypeOf<SessionSeq>()
  })

  it('brands same-process Session event positions while keeping the API wire numeric', () => {
    expectTypeOf<ISession['loadThrough']>().parameter(0).toEqualTypeOf<SessionSeq>()
    expectTypeOf<RenameSuccess['value']['seq']>().toEqualTypeOf<SessionSeq>()
    expectTypeOf<ProjectionValueStore['apply']>().parameter(2).toEqualTypeOf<SessionSeqCursor>()
    expectTypeOf<ProjectionsBaseline['asOfSeq']>().toEqualTypeOf<SessionSeqCursor>()
    expectTypeOf<SessionPageRequest['throughSeq']>().toEqualTypeOf<number>()
  })

  it('keeps its text and image prompt parts identical to attachment intake', () => {
    expectTypeOf<Exclude<SessionPromptContentPart, { type: 'file' }>>()
      .toEqualTypeOf<AttachmentPromptContentPart>()
  })

  it('publishes exact replace, prepend, and append event-window changes', () => {
    const feed = new MutableSessionEventSource()
    const listener = vi.fn()
    const dispose = feed.subscribe(listener)
    const first = entry(SessionSeq(1))
    const older = entry(SessionSeq(0))
    const live = entry(SessionSeq(2))

    feed.replace([first], true)
    expect(feed.getSnapshot()).toEqual({
      entries: [first],
      hasMore: true,
      revision: 1,
      change: { kind: 'replace', entries: [first] },
    })

    feed.prepend([older], false)
    expect(feed.getSnapshot()).toEqual({
      entries: [older, first],
      hasMore: false,
      revision: 2,
      change: { kind: 'prepend', entries: [older] },
    })

    feed.append(live)
    expect(feed.getSnapshot()).toEqual({
      entries: [older, first, live],
      hasMore: false,
      revision: 3,
      change: { kind: 'append', entries: [live] },
    })
    expect(listener).toHaveBeenCalledTimes(3)

    dispose()
    feed.append(entry(SessionSeq(3)))
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it('does not traverse the complete event window while appending', () => {
    const feed = new MutableSessionEventSource()
    const first = entry(SessionSeq(1))
    const base = [first]
    const iterate = vi.fn(Array.prototype[Symbol.iterator].bind(base))
    Object.defineProperty(base, Symbol.iterator, { value: iterate })
    feed.replace(base, false)
    iterate.mockClear()

    const before = feed.getSnapshot()
    const live = entry(SessionSeq(2))
    feed.append(live)
    const after = feed.getSnapshot()

    expect(iterate).not.toHaveBeenCalled()
    expect(before.entries).toEqual([first])
    expect(after.entries).toEqual([first, live])
    expect(after.entries).toBe(after.entries)
    expect(iterate).toHaveBeenCalledOnce()
  })

  it('drops retained turns only on a turn boundary and republishes the window as pageable', () => {
    const feed = new MutableSessionEventSource()
    const turn = (turnNumber: number): SessionLiveEventEntry[] => {
      const start = SessionSeq(turnNumber * 10)
      return [
        entry(start),
        { type: 'event', event: ev.user(SessionSeq(start + 1), `prompt ${turnNumber}`) },
        { type: 'event', event: ev.assistant(SessionSeq(start + 2), turnNumber, `answer ${turnNumber}`) },
      ]
    }
    const opening = [...turn(1), ...turn(2), ...turn(3)]
    feed.replace(opening, false)
    const listener = vi.fn()
    const dispose = feed.subscribe(listener)

    expect(feed.length).toBe(9)
    expect(feed.retainTurns(2)).toBe(SessionSeq(20))
    const trimmed = feed.getSnapshot()
    expect(trimmed.entries.map(candidate => candidate.event.seq)).toEqual(
      opening.slice(3).map(candidate => candidate.event.seq),
    )
    expect(trimmed.hasMore).toBe(true)
    expect(trimmed.change.kind).toBe('replace')
    expect(feed.length).toBe(6)

    expect(feed.retainTurns(3)).toBeUndefined()
    expect(feed.getSnapshot()).toBe(trimmed)
    expect(listener).toHaveBeenCalledOnce()
    dispose()
  })

  it('keeps the retained Client window inside its budget by dropping whole turns', () => {
    const feed = new MutableSessionEventSource()
    const entries: SessionLiveEventEntry[] = []
    for (let turnNumber = 1; turnNumber <= 40; turnNumber += 1) {
      const start = SessionSeq(turnNumber * 100)
      entries.push(entry(start))
      for (let offset = 1; offset <= 80; offset += 1) {
        entries.push({ type: 'event', event: ev.user(SessionSeq(start + offset), `m${turnNumber}-${offset}`) })
      }
    }
    feed.replace(entries, false)
    expect(feed.length).toBe(40 * 81)
    expect(feed.length).toBeGreaterThan(RETAINED_WINDOW_ENTRIES)

    expect(retainSessionWindow(feed)).toBe(SessionSeq(31 * 100))
    expect(feed.length).toBe(RETAINED_WINDOW_TURNS * 81)
    expect(feed.getSnapshot().hasMore).toBe(true)
    expect(retainSessionWindow(feed)).toBeUndefined()
  })

  it('publishes one exact Assistant settlement delta after retiring its transient rows', () => {
    const feed = new MutableSessionEventSource()
    const opening = entry(SessionSeq(1))
    const live = transient('attempt-one')
    const settlement = assistantSettlement(SessionSeq(2))
    const later = entry(SessionSeq(3))
    feed.replace([opening, live, later], false)

    feed.settleAssistant(LlmAttemptId('attempt-one'), settlement)

    expect(feed.getSnapshot()).toEqual({
      entries: [opening, settlement, later],
      hasMore: false,
      revision: 2,
      change: {
        kind: 'settle-assistant',
        attemptId: 'attempt-one',
        entry: settlement,
      },
    })

    feed.append(transient('attempt-two', 3.5))
    feed.settleAssistant(LlmAttemptId('attempt-two'))
    expect(feed.getSnapshot().entries).toEqual([opening, settlement, later])
    expect(feed.getSnapshot().change).toEqual({
      kind: 'settle-assistant',
      attemptId: 'attempt-two',
    })
  })

})
