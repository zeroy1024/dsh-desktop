/** Search owns a semantic index; raw event reads remain available for inspection. */
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { rewindRanges, isRewound } from './shared.ts'

export default class RewindSessionQueryEngine extends SqliteSessionQueryEngine {
  protected override get searchDocumentVersion(): string { return 'dsh-desktop/rewind-v1' }

  protected override buildSearchDocuments(sessionId: SessionId, events: readonly SessionEvent[]) {
    const ranges = rewindRanges(events)
    // Fold the complete log first: removing raw events would break seq-based
    // compaction references. Only the resulting search documents are filtered.
    const documents = super.buildSearchDocuments(sessionId, events)
    return ranges.length === 0 ? documents : documents.filter(document => !isRewound(document.seq, ranges))
  }
}
