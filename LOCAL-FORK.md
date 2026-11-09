# Local fork: bounded transcript window

This checkout is a local fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
that carries one change upstream does not ship: the Chat transcript mounts a
bounded Turn window instead of every loaded history row. The branch is
`local/transcript-window`; `master` stays a clean mirror of upstream.

## Why the fork exists

The Chat view seats one stable renderer per Conversation Node and keeps that
subtree mounted while a Turn-process disclosure hides it. The package README
says it outright ("Stable Chat Node Seats keep every renderer mounted"), so
collapsing a completed Turn is a paint decision, not a render one.

Measured on 2026-11-10 against this host with a headless Chrome, loading older
pages with the app's own "load earlier" control, sampling retained heap after a
forced garbage collection:

| Loaded pages | JS heap | Attached elements |
| --- | --- | --- |
| 0 | 43.0 MB | 2,989 |
| 5 | 71.6 MB | 11,007 |
| 10 | 98.9 MB | 21,191 |
| 15 | 129.4 MB | 31,660 |
| 20 | 163.1 MB | 42,749 |
| 25 | 188.2 MB | 52,398 |
| 30 | 215.1 MB | 62,999 |

About 5.8 MB of retained heap and 2,000 elements per page, linear, no plateau.
The session measured holds 74.4 M characters, so its whole history is roughly
1,080 pages and 6 GB of heap. Renderers in the wild sit at 1.7 to 3.7 GB, which
is a tab that loaded a few hundred pages through repeated scroll-back or a
jump to an old turn.

A plugin cannot fix this: the loaded event window lives in the session
controller and the seats stay mounted, so only the core chat view can unmount
them.

### Measured on this fork

Same session, same host hardware, same probe: this checkout served on a spare
port, headless Chrome on the Mac, the app's own "load earlier" control pressed
30 times, retained heap sampled after a forced collection.

| Pages loaded | JS heap | Attached elements | Chat nodes | Folded Turns |
| --- | --- | --- | --- | --- |
| 0 | 45.6 MB | 9,768 | 416 | 0 |
| 2 | 71.3 MB | 20,143 | 927 | 0 |
| 8 | 92.3 MB | 20,143 | 927 | 16 |
| 11 | 106.0 MB | 20,143 | 927 | 23 |
| 19 | 127.3 MB | 20,143 | 927 | 43 |
| 27 | 160.0 MB | 20,143 | 927 | 64 |
| 30 | 175.6 MB | 20,143 | 927 | 70 |

The mounted tree stops growing after the second page: elements and chat nodes
stay at 20,143 and 927 while 70 Turns and 1,019 entries fold behind one row.
The unpatched client reached 62,999 elements at the same 30 pages.

Heap is a different story. It still climbs about 4.3 MB per page from open to
page 30 (3.7 MB between page 2 and page 30) against the unpatched 5.7 MB per
page, so the fork removes roughly a quarter of the growth and none of the
linear law. Elements and rendered text stay flat, so the growth is not the
mounted rows; the uncompressed entry objects the session keeps for folded
history are the remaining suspect, and a heap-snapshot diff between two page
loads is the probe that would name the retainer.

Upstream status when this fork was made: the defect is reported and unfixed.
[#4900](https://github.com/deepseek-ai/deepseek-harness/discussions/4900) (open
since 2026-08-28, unanswered),
[#7579](https://github.com/deepseek-ai/deepseek-harness/discussions/7579) (names
the mechanism and ships the windowing patch this fork ports), and
[#10499](https://github.com/deepseek-ai/deepseek-harness/discussions/10499)
(same unbounded path in 0.2.2-alpha.2). Issues and pull requests are closed to
contributors, so the fix cannot land upstream and has to be carried here.

## What changed

- `packages/client/ui-chat/src/client/chat/transcript-window.ts` (new): pure
  projection of the loaded entries onto a fixed Turn budget, plus the page
  arithmetic a jump uses to raise that budget.
- `packages/client/ui-chat/src/client/chat/TranscriptFoldRow.tsx` and
  `.module.css` (new): the single row that stands in for the folded Turns.
- `ChatView.tsx`: holds the render budget (`windowPages`), projects the loaded
  entries, raises the budget on a reveal or a jump to a loaded but unseated
  Turn, and passes the projection to the flow.
- `ChatFlow.tsx`: seats the leading session rows, the fold row, and the retained
  suffix instead of every entry.
- `use-chat-navigation.ts`, `use-chat-scroll.ts`: a jump whose Turn is loaded
  but outside the budget now raises the budget and lands on the commit that
  seats the row, instead of silently doing nothing or jumping to a neighbour.
- `contract/slots.ts`: the flow's optional `transcriptWindow` prop.
- `locale.ts`: the fold row copy in all eight dictionaries.

Defaults: the newest 5 Turns keep their own seats; the fold row raises the
budget one page (5 Turns) at a time up to 8 pages; past that the existing
"Load earlier" pager takes over. Mounted rows therefore stay bounded no matter
how long the session ran.

The projection is generic over the entry type, and `pagesToRevealTurn` is pure,
so both are covered directly by unit tests.

## Upstream provenance

Ported from the patch attached to discussion #7579:

    git fetch https://github.com/V1sMu21/deepseek-harness.git perf/transcript-render-window
    # commit 63e7b0981e2677789514d498548107e58b4e322d, based on 0.1.6-alpha.2

That patch targets the pre-refactor `ChatView.tsx`. This fork re-implements the
same projection against 0.2.2-rc.1, where the row list moved into the
`conversation.chat.flow` slot and navigation into `use-chat-navigation.ts`.

## Verification

    pnpm install --frozen-lockfile
    node_modules/.bin/vitest run packages/client/ui-chat/tests     # 59 files, 991 tests
    cd packages/client/ui-chat && ../../../node_modules/.bin/tsc -p tsconfig.json

The new cases are `tests/transcript-window.client.spec.ts` (projection and page
arithmetic) and the `bounded transcript window` block in
`tests/chat-view.client.spec.tsx`, which renders a real ChatView and asserts:

- 12 Turns mount a bounded set of seats plus one fold row, never 72;
- 40 Turns mount exactly what 12 Turns mount, with the surplus reported by the
  fold row's `data-transcript-fold-turns=35`;
- clicking the fold row seats the next page of Turns and requests no history.

`tsc -b tsconfig.client.json` at the repo root reports pre-existing errors in
unrelated packages (session-controller tests, remote-mock tests and others);
the `ui-chat` package itself typechecks clean.

## Updating from upstream

1. `git fetch upstream && git rebase upstream/master` on `local/transcript-window`.
2. Resolve a conflict in `ChatView.tsx`, `ChatFlow.tsx`, `use-chat-navigation.ts`
   or `contract/slots.ts` by keeping upstream's new behaviour and re-applying the
   projection: what the flow seats is `transcriptWindow.retained` plus the fold
   row, and a jump to a loaded but unseated Turn must go through `revealTurn`.
3. Rerun the two verification commands above. The mount-bounded assertions are
   the guard: if they fail, the port is incomplete.
4. Force-push with lease to the fork (`git push --force-with-lease origin
   local/transcript-window`) and relink whatever profile serves the fork's build.

The cost of this fork is exactly that step: every upstream upgrade has to be
rebased through the transcript window, and the live GUI keeps serving the old
build until it is rebuilt and relinked.
