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
 * Mount the Host half: tail the Agent inbox feed into a log file.
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
