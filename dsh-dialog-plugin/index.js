/**
 * Host half of dsh-dialog-plugin.
 *
 * The plugin's UI lives in the browser, but the two things worth proving happen
 * on the Host: whether an interjection actually reached the running turn, and
 * whether the discussion panel's own conversation really exchanged messages.
 * Both are observable through the Agent inbox feed:
 *
 * - `agent/inbox/inserted` — a message entered the live inbox.
 * - `agent/inbox/claimed` — one message left the inbox inside its open turn.
 *
 * A `steer` prompt inserts straight into that inbox and is claimed by the turn
 * already running; a `queue` prompt waits for the next turn. Watching both
 * events therefore records, in a plain log file, whether a delivered line was
 * picked up by the current turn or deferred — which is exactly the evidence a
 * "did my interjection land?" question needs.
 *
 * The second thing the Host half does is cheaper side discussions. The
 * discussion panel forks a Session and prefixes every line with a short
 * "quick mode" brief; that prefix is the only reliable mark of a side branch,
 * because an ordinary fork carries no distinguishing header field. Recognising
 * the mark lets the Host drop just that Session to a lower reasoning effort
 * before its turn starts, while the main conversation keeps the global default.
 *
 * `apply` is optional work: the UI keeps working when this half is disabled,
 * because delivery itself goes through the Session Controller's own `prompt`
 * face rather than through anything registered here.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Directory holding this plugin's own log, under the DSH home. */
const LOG_DIR = join(homedir(), '.dsh', 'dsh-dialog-plugin')
const LOG_FILE = join(LOG_DIR, 'inbox.log')

/** Cap on the message text echoed into the log, so one huge paste stays readable. */
const MAX_LOGGED_TEXT = 400

/**
 * Opening words of the "quick mode" brief the discussion panel puts in front of
 * every line it sends to a branch Session.
 *
 * The panel writes that brief in the reader's language, so both spellings are
 * recognised here. These strings must stay in step with `DICT.zh.panelBrief`
 * and `DICT.en.panelBrief` in `client.js`.
 */
const BRANCH_MARKERS = [
  '这是主对话旁边的一条支线',
  'This is a side branch next to the main conversation',
]

/**
 * Reasoning effort a side branch runs at, so a discussion settles quickly
 * instead of matching the main conversation's depth.
 */
const BRANCH_REASONING_EFFORT = 'low'

/**
 * Whether one text part belongs to a discussion branch rather than the main
 * conversation.
 * @param text - one text part of a prompt or inbox message.
 * @returns true when the text opens with the quick-mode brief.
 */
function isBranchText(text) {
  if (typeof text !== 'string') return false
  const head = text.trimStart()
  return BRANCH_MARKERS.some(marker => head.startsWith(marker))
}

/**
 * Drop one discussion branch to the cheaper reasoning effort.
 *
 * This runs when the line enters the inbox, not when the step starts: the
 * Agent reads its model selection before the pre-step waterfall runs, so a
 * change made there would only reach the step after it. Selecting on insertion
 * also records the choice in the branch's own log, which keeps it in force when
 * that Session is resumed later.
 *
 * @param agent - the Agent driving the branch Session.
 * @param message - the inbox message just inserted.
 */
function cheapenBranch(agent, message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  const fromBranch = parts.some(part => part?.type === 'text' && isBranchText(part.text))
  if (!fromBranch) return
  const current = agent?.model?.current?.()
  if (current === undefined) return
  if (current.reasoningEffort === BRANCH_REASONING_EFFORT) return
  try {
    agent.model.select({
      provider: current.provider,
      model: current.model,
      reasoningEffort: BRANCH_REASONING_EFFORT,
    })
  } catch (error) {
    console.warn('[dsh-dialog-plugin] could not lower the side branch reasoning effort:', error)
  }
}

/**
 * Summarize a UserMessage for the log without dumping its whole payload.
 * @param message - the inbox message the Agent reported.
 * @returns a single-line description.
 */
function describeMessage(message) {
  const parts = Array.isArray(message?.content) ? message.content : []
  const texts = []
  for (const part of parts) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text)
    } else if (typeof part?.type === 'string') {
      texts.push(`[${part.type}]`)
    }
  }
  const joined = texts.join(' ').replace(/\s+/g, ' ').trim()
  const clipped = joined.length > MAX_LOGGED_TEXT ? `${joined.slice(0, MAX_LOGGED_TEXT)}…` : joined
  return clipped === '' ? '(no text)' : clipped
}

/**
 * Append one JSON line to the plugin log.
 *
 * Logging must never disturb the Agent loop: a failed write is reported once to
 * the console and then ignored, because the feed that calls this is a
 * fire-and-forget emit whose listeners must not throw.
 *
 * @param record - the fields to record; a timestamp is added here.
 */
async function record(record) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
  try {
    await mkdir(LOG_DIR, { recursive: true })
    await appendFile(LOG_FILE, line, 'utf8')
  } catch (error) {
    console.warn('[dsh-dialog-plugin] could not write the inbox log:', error)
  }
}

/**
 * Mount the Host half: tail the Agent inbox feed into a log file, and keep
 * discussion branches on a cheaper reasoning effort.
 * @param ctx - the Host cordis context.
 */
export function apply(ctx) {
  ctx.effect(() => {
    const offInserted = ctx.on('agent/inbox/inserted', payload => {
      void record({
        kind: 'inserted',
        sessionId: payload?.agent?.id ?? payload?.agent?.sessionId,
        turn: payload?.turn,
        messageId: payload?.message?.id,
        text: describeMessage(payload?.message),
      })
      cheapenBranch(payload?.agent, payload?.message)
    })

    const offClaimed = ctx.on('agent/inbox/claimed', payload => {
      void record({
        kind: 'claimed',
        sessionId: payload?.agent?.id ?? payload?.agent?.sessionId,
        turn: payload?.turn,
        messageId: payload?.message?.id,
        text: describeMessage(payload?.message),
      })
    })

    return () => {
      offInserted()
      offClaimed()
    }
  }, 'dsh-dialog-plugin: inbox evidence log')
}
