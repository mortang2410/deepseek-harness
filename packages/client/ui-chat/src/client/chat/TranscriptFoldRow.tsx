import { memo } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TranscriptFoldGroup } from './transcript-window.ts'
import css from './TranscriptFoldRow.module.css'

/** Row standing in for Turns outside the bounded render window. */
export interface TranscriptFoldRowProps {
  readonly group: TranscriptFoldGroup
  readonly busy: boolean
  readonly onReveal: () => void
  readonly t: ChatViewSlotProps['t']
}

/**
 * Render the collapsed older-Turn stretch as one row. Its processes are not
 * mounted at all, so this row is the whole DOM cost of the folded history.
 * @param props - fold summary plus the reveal handler.
 * @returns the fold row.
 */
export const TranscriptFoldRow = memo(function TranscriptFoldRow({
  group, busy, onReveal, t,
}: TranscriptFoldRowProps) {
  return (
    <div className={css.root} data-transcript-fold-turns={group.turns.length}>
      <button
        type="button"
        className={css.button}
        disabled={busy}
        aria-label={t('chat.transcriptFolded', { turns: group.turns.length })}
        onClick={onReveal}
      >
        <span className={css.label}>{t('chat.transcriptFolded', { turns: group.turns.length })}</span>
        <span className={css.hint}>{busy ? t('loading') : t('chat.transcriptFolded.hint')}</span>
        <IconChevronDownOutlineRegular className={css.chevron} />
      </button>
    </div>
  )
})
