/**
 * Client half of dsh-dialog-plugin.
 *
 * Two features, both entirely in the browser:
 *
 * 1. **Interject** — a control in the composer tool row that sends text into the
 *    turn that is already running, instead of queueing it behind that turn.
 *    Delivery goes through the Session Controller's own `prompt` face with
 *    `mode: 'steer'`, which the Host consumes at the next step boundary (an idle
 *    session starts a turn instead). No Host change is involved.
 * 2. **Side discussion** — a right-hand tab that keeps its own conversation, so a
 *    disagreement can be talked through without touching the main thread.
 *
 * Everything uses only `react`, `react-dom` and the runtime services declared in
 * `inject`; the plugin never imports another @deepseek-ai package at runtime.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dialog-plugin',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement
    const { createPortal } = require('react-dom')

    /** Locale namespace; the dictionaries below are registered under it. */
    const NS = 'dsh-dialog-plugin'

    /**
     * Copy for both features. Kept in the bundle rather than in `locale/*.json`
     * so the browser half needs no asset fetch; the JSON files serve the Plugin
     * Manager's display metadata.
     */
    const DICT = {
      zh: {
        button: '插话',
        title: '插一句话进当前回合',
        titleBusy: '这一轮正在跑，插话会在下一个步骤边界被读到',
        hint: '这条消息会在当前回合的下一个步骤边界被读到，不用等它跑完。',
        placeholder: '说说你的看法、纠正，或者要问的问题……',
        send: '插话',
        cancel: '取消',
        empty: '先写点什么。',
        sending: '发送中……',
        sent: '已插入这一轮。',
        queued: '这一轮刚结束，于是作为下一条消息发出。',
        failed: '没能送达：{reason}',
        panelTitle: '旁路讨论',
        panelIntro: '这条支线从当前对话分叉出来，只在这里聊，不影响主对话。',
        panelStart: '开始讨论',
        panelStarting: '正在分支……',
        panelPreparing: '正在准备支线……',
        panelFailed: '支线没能建立：{reason}',
        panelPlaceholder: '把分歧写在这里……',
        panelSend: '发送',
        panelEmpty: '还没有消息，说点什么开始。',
        panelYou: '你',
        panelAgent: '助手',
        panelWait: '（思考中）',
        panelReset: '重建支线',
        panelResetHint: '丢掉这条支线，下次从最新进度重新分叉。',
        panelSidebarHint: '打开右侧栏能看到这条支线。',
        panelOpen: '旁路讨论',
        panelToggleHint: '在右侧栏继续这条支线。',
        panelToggleHintBusy: '主对话正在跑，旁路讨论可以同时开一条支线。',
        panelForkFailed: '没能从当前对话分叉：{reason}',
        panelNeedSession: '还没有打开会话。',
        panelWaitTurn: '主对话这一轮还没跑完。等它结束后再点重试，支线才能从已完成的地方分叉。',
        panelRetry: '重试',
        activityThinking: '正在思考…',
        activityNow: '\u6b63\u5728{what}',
        activityDone: '刚做完：{what}',
        activityToggle: '步骤提示',
        activityToggleOnHint: '输入框上方那一行中文正在显示。点一下可以关掉。',
        activityToggleOffHint: '输入框上方那一行中文已关闭。点一下重新打开。',
      },
      en: {
        button: 'Interject',
        title: 'Interject into the running turn',
        titleBusy: 'A turn is running; this reaches it at the next step boundary',
        hint: 'This reaches the current turn at its next step — no need to wait for it to finish.',
        placeholder: 'A remark, a correction, or a question…',
        send: 'Interject',
        cancel: 'Cancel',
        empty: 'Type something first.',
        sending: 'Sending…',
        sent: 'Interjected into this turn.',
        queued: 'That turn had just finished, so this went out as the next message.',
        failed: 'Could not deliver: {reason}',
        panelTitle: 'Side discussion',
        panelIntro: 'This branch forks the main conversation. Talk here without touching the main thread.',
        panelStart: 'Start discussion',
        panelStarting: 'Forking…',
        panelPreparing: 'Preparing the branch…',
        panelFailed: 'Could not set up the branch: {reason}',
        panelPlaceholder: 'Write the disagreement here…',
        panelSend: 'Send',
        panelEmpty: 'No messages yet — say something to begin.',
        panelYou: 'You',
        panelAgent: 'Assistant',
        panelWait: '(thinking)',
        panelReset: 'Reset branch',
        panelResetHint: 'Drop this branch and fork again from the latest progress.',
        panelSidebarHint: 'Open the right sidebar to see this branch.',
        panelOpen: 'Side discussion',
        panelForkFailed: 'Could not fork the conversation: {reason}',
        panelNeedSession: 'No session is open.',
        panelToggleHint: 'Continue this branch in the right sidebar.',
        panelToggleHintBusy: 'The main conversation is running; a side discussion can branch off alongside it.',
        panelWaitTurn: 'The main conversation has not finished a turn yet. Retry once it has, so the branch can fork from a completed point.',
        panelRetry: 'Retry',
        activityThinking: 'Thinking…',
        activityNow: '{what}',
        activityDone: 'Just finished: {what}',
        activityToggle: 'Step line',
        activityToggleOnHint: 'The plain-language line above the box is showing. Click to hide it.',
        activityToggleOffHint: 'The plain-language line above the box is hidden. Click to show it.',
      },
    }

    /**
     * Read one localized string.
     * @param language - active language tag.
     * @param key - key inside the active dictionary.
     * @param vars - `{name}` substitutions.
     * @returns the localized text, falling back to English, then to the key.
     */
    function text(language, key, vars) {
      const table = DICT[language] ?? DICT.en
      const raw = table[key] ?? DICT.en[key] ?? key
      if (vars === undefined) return raw
      return raw.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
    }

    /**
     * Render the two inline Markdown forms that show up in chat transcripts.
     *
     * A discussion bubble is a chat line, not a document: `**bold**` and
     * `` `code` `` are the only markup worth honouring, and leaving the raw
     * asterisks and backticks in place reads like corruption. Everything else
     * stays literal, so a stray `*` cannot swallow the rest of the message.
     *
     * @param raw - one message body.
     * @returns a node array ready for `React.createElement`.
     */
    function renderInline(raw) {
      const source = typeof raw === 'string' ? raw : ''
      const nodes = []
      const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g
      let cursor = 0
      let match = pattern.exec(source)
      while (match !== null) {
        if (match.index > cursor) nodes.push(source.slice(cursor, match.index))
        if (typeof match[1] === 'string') nodes.push(h('strong', { key: `b${match.index}` }, match[1]))
        else nodes.push(h('code', { key: `c${match.index}` }, match[2]))
        cursor = match.index + match[0].length
        match = pattern.exec(source)
      }
      if (cursor < source.length) nodes.push(source.slice(cursor))
      return nodes
    }

    /** Detect the language the shell is showing. */
    function detectLanguage() {
      const candidates = []
      try {
        candidates.push(globalThis.document?.documentElement?.lang)
        candidates.push(globalThis.navigator?.language)
      } catch {}
      for (const value of candidates) {
        if (typeof value !== 'string' || value === '') continue
        const lower = value.toLowerCase()
        if (lower.startsWith('zh')) return 'zh'
        if (lower.startsWith('en')) return 'en'
      }
      return 'en'
    }

    //#region Delivery — the shared path both features send through

    /**
     * Whether a prompt result reports success.
     *
     * `SessionFace.prompt` resolves to `RemoteResult<{accepted: true}>`, which is
     * `{ok: true, value}` or `{ok: false, error}`.
     * @param result - value returned by `SessionFace.prompt`.
     */
    function promptSucceeded(result) {
      if (result === undefined || result === null) return false
      if (typeof result !== 'object') return false
      if (result.ok === false) return false
      if (result.value !== undefined && result.value !== null) return result.value.accepted !== false
      return result.accepted !== false
    }

    /**
     * Subscribe to a session snapshot's `running` flag.
     * @param useSession - the slot's `useSession` selector hook, if the slot hands one over.
     * @returns whether a turn is running right now.
     */
    function useSnapshotRunning(useSession) {
      if (typeof useSession !== 'function') return false
      try {
        return useSession(snapshot => snapshot?.running === true) === true
      } catch {
        return false
      }
    }

    /**
     * Describe a failed prompt result for the user.
     * @param result - value returned by `SessionFace.prompt`.
     */
    function describeFailure(result) {
      if (result && typeof result === 'object') {
        if (result.error && typeof result.error === 'object') {
          const { code, message } = result.error
          if (typeof message === 'string' && message !== '') {
            return typeof code === 'string' && code !== '' ? `${code}: ${message}` : message
          }
        }
        if (typeof result.error === 'string' && result.error !== '') return result.error
        if (typeof result.message === 'string' && result.message !== '') return result.message
      }
      return String(result)
    }

    /**
     * Whether a session snapshot says a turn is currently running.
     * @param snapshot - a `SessionSnapshot`, or undefined before the first read.
     */
    function snapshotIsRunning(snapshot) {
      return snapshot !== undefined && snapshot !== null && snapshot.running === true
    }

    /**
     * Resolve the live `SessionFace` for one id.
     *
     * A bare snapshot hook hands out data, not submission methods, so the face
     * comes from the sessions service: retain the id, read `binding.session`,
     * and release immediately — the surrounding UI already holds its own
     * reference, so this borrow is short and cannot outlive the call.
     *
     * @param sessions - the `sessions` service.
     * @param sessionId - target session.
     * @returns the face, or undefined when no generation is retained.
     */
    function sessionFace(sessions, sessionId) {
      if (sessions === undefined || sessions === null || sessionId === undefined) return undefined
      const existing = sessions.binding?.(sessionId)
      if (existing !== undefined) return existing.session
      let reference
      try {
        reference = sessions.retain(sessionId, { source: 'gateway' })
      } catch {
        return undefined
      }
      const face = reference?.binding?.session
      // Defer the release so the caller can still await a prompt started from it.
      if (face !== undefined && face !== null) {
        const release = () => reference.release?.()
        Promise.resolve().then(() => globalThis.setTimeout(release, 15000))
        return face
      }
      reference?.release?.()
      return undefined
    }

    /**
     * Send one line into a session.
     *
     * `steer` is the delivery mode that reaches the turn already running; an
     * idle session starts a new turn instead. When the controller refuses a
     * steer (the turn ended between the click and the send) the call is retried
     * as an ordinary queued message so the text is never silently dropped.
     *
     * @param sessions - the `sessions` service.
     * @param sessionId - target session.
     * @param body - message text.
     * @param mode - preferred delivery mode; `steer` falls back to `queue`.
     * @returns the delivery mode actually used, or a failure description.
     */
    async function deliverToSession(sessions, sessionId, body, mode = 'steer') {
      const face = sessionFace(sessions, sessionId)
      if (face === undefined) return { ok: false, reason: 'session is not retained' }
      if (typeof face.prompt !== 'function') return { ok: false, reason: 'session has no prompt face' }
      const content = [{ type: 'text', text: body }]
      if (mode !== 'steer') {
        const queued = await face.prompt(content, 'queue')
        if (promptSucceeded(queued)) return { ok: true, mode: 'queue' }
        return { ok: false, reason: describeFailure(queued) }
      }
      const first = await face.prompt(content, 'steer')
      if (promptSucceeded(first)) return { ok: true, mode: 'steer' }
      const second = await face.prompt(content, 'queue')
      if (promptSucceeded(second)) return { ok: true, mode: 'queue' }
      return { ok: false, reason: describeFailure(second ?? first) }
    }

    //#endregion

    //#region Activity — a live one-line summary of what the assistant is doing

    /** Longest summary line kept; the row ellipsizes beyond it anyway. */
    const ACTIVITY_MAX_CHARS = 80

    /**
     * Tool name to a short verb phrase, per language.
     *
     * Only the phrasing lives here; the interesting part of the line is the
     * argument (which file, which pattern, which command), which `activityLine`
     * extracts per tool.
     */
    const ACTIVITY_TOOLS = {
      pwsh: ['执行命令', 'running a command'],
      bash: ['执行命令', 'running a command'],
      read: ['读文件', 'reading'],
      write: ['写文件', 'writing'],
      edit: ['改文件', 'editing'],
      grep: ['搜索代码', 'searching'],
      glob: ['查找文件', 'finding'],
      web_search: ['搜索网页', 'searching the web'],
      web_fetch: ['抓取网页', 'fetching'],
      subagent: ['派子任务', 'delegating'],
      subagent_fork: ['派子任务', 'delegating'],
      cordis_inspect_query: ['查运行环境', 'inspecting'],
      cordis_inspect_list: ['查运行环境', 'inspecting'],
      compress: ['压缩上下文', 'compacting context'],
      decompress: ['还原上下文', 'restoring context'],
      ask_user_question: ['向你提问', 'asking you'],
      todo_write: ['更新任务列表', 'updating the todo list'],
      present: ['交付文件', 'presenting'],
      job_output: ['读后台任务', 'reading a job'],
      job_kill: ['停后台任务', 'stopping a job'],
    }

    /** Collapse whitespace and cap the length of one fragment. */
    function clipLine(value, max) {
      if (typeof value !== 'string') return ''
      const flat = value.replace(/\s+/g, ' ').trim()
      if (flat.length <= max) return flat
      return flat.slice(0, Math.max(0, max - 1)) + '\u2026'
    }

    /** The trailing path segment, for showing a file without its directories. */
    function baseName(value) {
      if (typeof value !== 'string' || value === '') return ''
      const parts = value.split(/[\\/]/)
      const last = parts[parts.length - 1]
      return last === undefined || last === '' ? value : last
    }

    /** The first non-blank line of a multi-line string. */
    function firstLineOf(value) {
      if (typeof value !== 'string') return ''
      for (const line of value.split('\n')) {
        if (line.trim() !== '') return line.trim()
      }
      return ''
    }

    /** Tool arguments arrive as a JSON string, not an object. */
    function parseToolArguments(raw) {
      if (raw !== null && typeof raw === 'object') return raw
      if (typeof raw !== 'string' || raw === '') return {}
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }

    /**
     * The `▶` preamble of one assistant message, if it wrote one.
     *
     * The convention is the assistant's own: one line beginning with `▶` saying
     * what the next action is and why. Nothing in the harness produces it, so
     * every caller must cope with its absence.
     */
    function preambleOf(event) {
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) return undefined
      let found
      for (const part of content) {
        if (part === null || typeof part !== 'object') continue
        if (part.type !== 'text' || typeof part.text !== 'string') continue
        for (const line of part.text.split('\n')) {
          const at = line.indexOf('\u25B6')
          if (at === -1) continue
          let rest = line
            .slice(at + 1)
            .replace(/[\uFE0E\uFE0F]/g, '')
            .replace(/\*\*/g, '')
            .replace(/\x60/g, '')
            .trim()
          // The convention ends the sentence before a rationale; the row shows
          // only the action.
          const cut = rest.search(/\u2014/)+0
          if (cut > 0) rest = rest.slice(0, cut).trim()
          if (rest !== '') found = rest.replace(/[：:]$/u, '')
        }
      }
      return found
    }

    /**
     * Trim a preamble to its action clause.
     *
     * These lines are written as "<what this step does> —— <why>", often with a
     * second sentence of detail. The row has one line, so only the first clause
     * is kept; the rest is in the transcript a scroll away.
     */
    function preambleLine(value) {
      // Drop this project's own bookkeeping prefix ("Step 7: ...") — the reader
      // wants the action, not the counter.
      let line = clipLine(value, 160).replace(/^第?\s*\d+\s*[步.]+\s*[：:，,、.\-—]?\s*/, '')
      const separators = /[\u3002\uFF1B;\uFF1A]/g
      let match
      while ((match = separators.exec(line)) !== null) {
        if (match.index > 8) {
          line = line.slice(0, match.index)
          break
        }
      }
      return clipLine(line.replace(/[\u3002\uFF1B;\uFF1A\uFF0C,]$/, '').trim(), ACTIVITY_MAX_CHARS)
    }

    /** Turn one `tool/call` into a readable line. */
    function activityLine(name, argumentsRaw) {
      const tool = typeof name === 'string' && name !== '' ? name : 'tool'
      const args = parseToolArguments(argumentsRaw)
      const zh = detectLanguage() === 'zh'
      const known = ACTIVITY_TOOLS[tool]
      const verb = known === undefined ? (zh ? '调用 ' + tool : tool) : zh ? known[0] : known[1]
      const files = Array.isArray(args.files) ? args.files : []
      let detail = ''
      if (tool === 'read' || tool === 'write' || tool === 'edit') {
        detail = baseName(args.file_path ?? args.path)
      } else if (tool === 'grep' || tool === 'glob') {
        detail = clipLine(args.pattern, 48)
      } else if (tool === 'pwsh' || tool === 'bash') {
        // The command text is unreadable at a glance, so a tool that carries its
        // own short description is published verbatim.
        const described = clipLine(args.description, 72)
        if (described !== '') return { line: clipLine(described, ACTIVITY_MAX_CHARS), described: true }
        detail = clipLine(firstLineOf(args.command ?? args.script), 64)
      } else if (tool === 'web_search') {
        const queries = args.queries
        detail = clipLine(Array.isArray(queries) ? queries.join(' / ') : queries, 52)
      } else if (tool === 'web_fetch') {
        detail = clipLine(args.url, 64)
      } else if (tool === 'subagent' || tool === 'subagent_fork') {
        detail = clipLine(args.description, 42)
      } else if (tool === 'cordis_inspect_query' || tool === 'cordis_inspect_list') {
        detail = clipLine([args.provider, args.method].filter(item => typeof item === 'string').join('.'), 42)
      } else if (tool === 'ask_user_question') {
        detail = zh ? '等你回答' : 'waiting for your answer'
      } else if (tool === 'present') {
        detail = clipLine(
          files.map(item => baseName(item?.path)).filter(item => item !== '').join(' / '),
          42
        )
      }
      return { line: clipLine(detail === '' ? verb : `${verb} ${detail}`, ACTIVITY_MAX_CHARS), described: false }
    }

    /** Flatten a `SessionEventWindow.entries` list into the events it wraps. */
    function collectEvents(entries) {
      const events = []
      if (!Array.isArray(entries)) return events
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        if (entry.type !== 'event') continue
        const event = entry.event
        if (event === null || typeof event !== 'object') continue
        events.push(event)
      }
      return events
    }

    /** Whether the tool call at `from` already produced its result. */
    function toolHasSettled(events, from, callId) {
      for (let index = from + 1; index < events.length; index += 1) {
        const event = events[index]
        if (String(event?.type ?? '') !== 'tool/result') continue
        if (event?.data?.callId === callId) return true
      }
      return false
    }

    /**
     * Work out the one line worth showing right now.
     *
     * The window is the same source the conversation view renders, so the line
     * trails the Host by one event at most. Nothing is generated here: the
     * assistant's own `▶` preamble is preferred when it wrote one, and a
     * tool-name mapping covers everything else, which keeps the row free.
     *
     * @param entries - `SessionEventWindow.entries`.
     * @returns `{ kind, line }`, or undefined when no turn is in flight.
     */
    function describeActivity(entries) {
      const events = collectEvents(entries)
      if (events.length === 0) return undefined
      // Only the newest turn matters: an older one is finished by definition.
      let turnOpen = false
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const type = String(events[index].type ?? '')
        if (type === 'turn/end') break
        if (type === 'turn/start') {
          turnOpen = true
          break
        }
      }
      if (!turnOpen) return undefined
      // Within the turn only the newest step is in flight. Bounding the scan to
      // it keeps a settled call from an earlier step out of the row.
      let stepAt = 0
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const type = String(events[index].type ?? '')
        if (type === 'step/start' || type === 'step/end') {
          stepAt = index
          break
        }
      }
      let callAt = -1
      let messageAt = -1
      for (let index = events.length - 1; index >= stepAt; index -= 1) {
        const type = String(events[index].type ?? '')
        if (callAt === -1 && type === 'tool/call') callAt = index
        if (messageAt === -1 && type === 'assistant/message') messageAt = index
        if (callAt !== -1 && messageAt !== -1) break
      }
      // The assistant's own preamble is the sentence the reader asked for: it is
      // written for a person and names the intent. The tool mapping below is the
      // fallback for steps that carry no preamble.
      if (messageAt !== -1) {
        const preamble = preambleOf(events[messageAt])
        if (preamble !== undefined) {
          return { kind: 'preamble', line: preambleLine(preamble) }
        }
      }
      if (callAt !== -1) {
        const event = events[callAt]
        const callId = typeof event.data?.callId === 'string' ? event.data.callId : ''
        const called = activityLine(event.data?.name, event.data?.arguments)
        // A line the tool wrote itself already reads as a sentence, so it is
        // published as written instead of being wrapped in a verb.
        if (called.described) return { kind: 'preamble', line: called.line }
        const settled = callId !== '' && toolHasSettled(events, callAt, callId)
        return { kind: settled ? 'done' : 'tool', line: called.line }
      }
      return { kind: 'thinking', line: '' }
    }
    /**
     * Subscribe to the session's event window and report what is happening.
     *
     * @param sessions - the `sessions` service.
     * @param sessionId - session to observe.
     * @returns the current activity, or undefined when the session is idle.
     */
    function useActivity(sessions, sessionId) {
      const [activity, setActivity] = useState(undefined)
      useEffect(() => {
        setActivity(undefined)
        if (sessions === undefined || sessions === null || sessionId === undefined) return undefined
        let binding
        let borrowed
        try {
          binding = sessions.binding?.(sessionId)
          if (binding === undefined) {
            borrowed = sessions.retain?.(sessionId, { source: 'gateway' })
            binding = borrowed?.binding
          }
        } catch {
          binding = undefined
        }
        if (binding === undefined) return undefined
        const source = binding.eventSource
        if (source === undefined || source === null) return undefined
        // The snapshot is mutated in place, so the published `revision` is the
        // only signal that something was appended.
        let lastRevision = -1
        const read = () => {
          try {
            const window = source.getSnapshot()
            const revision = typeof window?.revision === 'number' ? window.revision : -1
            if (revision === lastRevision) return
            lastRevision = revision
            setActivity(describeActivity(window?.entries))
          } catch {
            setActivity(undefined)
          }
        }
        read()
        const off = source.subscribe?.(read)
        // A dropped frame would freeze the row, so it is re-read on a slow beat.
        const view = globalThis
        const settle = view.setInterval?.(read, 900)
        return () => {
          if (typeof off === 'function') off()
          if (settle !== undefined) view.clearInterval?.(settle)
          if (borrowed !== undefined) {
            try {
              borrowed.release?.()
            } catch {}
          }
        }
      }, [sessions, sessionId])
      return activity
    }

    /**
     * One ambient line under the composer: what the assistant is doing now.
     *
     * @param props - the slot face: `sessionId`, `useSession`.
     */
    function ActivityLine(props) {
      const { sessionId, useSession } = props
      const sessions = useSessionsService()
      const running = useSnapshotRunning(useSession)
      const [on] = useActivityOn()
      const activity = useActivity(sessions, sessionId)
      const language = detectLanguage()

      // A hidden line still subscribes (so turning it back on is instant), but
      // it does not take part in the layout.
      if (on !== true) return null

      let tone = 'idle'
      let label = ''
      if (activity !== undefined) {
        tone = activity.kind === 'done' ? 'done' : 'active'
        if (activity.kind === 'thinking') {
          label = text(language, 'activityThinking')
        } else if (activity.kind === 'preamble') {
          // The assistant's own wording already reads as a sentence, so it is
          // shown as written instead of being wrapped in a verb.
          label = activity.line
        } else {
          label = text(language, activity.kind === 'done' ? 'activityDone' : 'activityNow', {
            what: activity.line,
          })
        }
      } else if (running === true) {
        tone = 'active'
        label = text(language, 'activityThinking')
      }
      if (label === '') return null
      return h(
        'div',
        { className: 'dsh-dialog-activity', 'data-tone': tone, title: label },
        h('span', { className: 'dsh-dialog-activity-dot', 'aria-hidden': true }),
        h('span', { className: 'dsh-dialog-activity-text' }, label)
      )
    }

    /** The status glyph: three stacked lines, the last one short. */
    function ActivityIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M2.4 4h11.2M2.4 8h8.4M2.4 12h5.2',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.4,
          'stroke-linecap': 'round',
        })
      )
    }

    /**
     * Composer tool-row switch for the ambient status line.
     *
     * The line is on unless the reader turned it off, so the control reports the
     * current state instead of implying a one-shot action.
     */
    function ActivityToggle() {
      const language = detectLanguage()
      const [on, setOn] = useActivityOn()
      // The control stays put in both states: hiding it while the line is off
      // would leave no way back on. Its label is the feature name; the lit
      // `data-on` style carries on/off. It deliberately does NOT reuse the
      // `data-busy` style the two buttons beside it use for a running turn:
      // that one is a solid fill now, and a permanently filled switch would
      // read as "something is happening" instead of "this is on".
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-dialog-interject-button',
          'data-on': on === true ? 'true' : 'false',
          title: text(language, on === true ? 'activityToggleOnHint' : 'activityToggleOffHint'),
          'aria-pressed': on === true ? 'true' : 'false',
          onClick: () => setOn(on !== true),
        },
        h(ActivityIcon, null),
        h('span', null, text(language, 'activityToggle'))
      )
    }

    //#endregion

    //#region Activity switch — the line is on by default and can be turned off

    /** localStorage key holding `"off"` once the reader hides the line. */
    const ACTIVITY_KEY = 'dsh-dialog-plugin.activity'

    /** Subscribers to the switch; both faces read it so they never disagree. */
    const activityListeners = new Set()

    /**
     * Whether the ambient status line is shown.
     *
     * An absent record means on: the line is the point of the feature, so a
     * first run shows it instead of greeting the reader with nothing.
     */
    function readActivityOn() {
      try {
        return globalThis.localStorage?.getItem(ACTIVITY_KEY) !== 'off'
      } catch {
        return true
      }
    }

    /** Remember the switch and wake every subscriber. */
    function setActivityOn(on) {
      try {
        if (on) globalThis.localStorage?.removeItem(ACTIVITY_KEY)
        else globalThis.localStorage?.setItem(ACTIVITY_KEY, 'off')
      } catch {}
      for (const listener of [...activityListeners]) {
        try {
          listener()
        } catch {}
      }
    }

    /**
     * Follow the switch from a component.
     * @returns the current value and the setter, as `[on, setActivityOn]`.
     */
    function useActivityOn() {
      const [on, setOn] = useState(readActivityOn)
      useEffect(() => {
        const read = () => setOn(readActivityOn())
        activityListeners.add(read)
        return () => {
          activityListeners.delete(read)
        }
      }, [])
      return [on, setActivityOn]
    }

    //#endregion

    //#region Interject — the composer tool-row control

    const PANEL_WIDTH = 340

    /**
     * Shared panel styling; injected once per document.
     *
     * Colours come from the harness theme tokens (`--dsw-alias-*`). Never
     * hard-code a background here: the document is either dark or light, and a
     * literal `#fff` panel with inherited light text renders every label
     * invisible. The fallbacks below only matter when a token is missing, so
     * they carry the same role rather than a fixed colour where that is
     * possible.
     */
    const PANEL_CSS = `
.dsh-dialog-interject-anchor{display:inline-flex;align-items:center}
.dsh-dialog-interject-button{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1;cursor:pointer;opacity:.86}
.dsh-dialog-interject-button:hover{opacity:1;background:var(--dsw-alias-bg-layer-2)}
.dsh-dialog-interject-button[data-busy="true"]{opacity:1;color:#2f6fdd;border-color:color-mix(in srgb,#2f6fdd 58%,transparent);background:color-mix(in srgb,#2f6fdd 12%,transparent)}
body[data-ds-dark-theme] .dsh-dialog-interject-button[data-busy="true"]{color:#7aa9fd;border-color:color-mix(in srgb,#7aa9fd 58%,transparent);background:color-mix(in srgb,#7aa9fd 14%,transparent)}
.dsh-dialog-interject-button[data-on="true"]{opacity:1;color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,transparent)}
.dsh-dialog-interject-button svg{display:block}
.dsh-dialog-interject-popover{position:fixed;z-index:2147483000;box-sizing:border-box;width:${PANEL_WIDTH}px;padding:10px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 10px 30px rgba(0,0,0,.28);font:inherit;font-size:13px}
.dsh-dialog-interject-head{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.dsh-dialog-interject-head .spacer{flex:1 1 auto}
.dsh-dialog-interject-close{flex:none;width:22px;height:22px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}
.dsh-dialog-interject-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-dialog-interject-title{font-weight:600}
.dsh-dialog-interject-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45;margin-bottom:8px}
.dsh-dialog-interject-input{box-sizing:border-box;width:100%;min-height:76px;max-height:220px;resize:vertical;padding:8px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.dsh-dialog-interject-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72}
.dsh-dialog-interject-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-dialog-interject-row{display:flex;align-items:center;gap:8px;margin-top:8px}
.dsh-dialog-interject-row .spacer{flex:1 1 auto}
.dsh-dialog-interject-action{height:28px;padding:0 12px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1;cursor:pointer;white-space:nowrap}
.dsh-dialog-interject-action[data-variant="primary"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.dsh-dialog-interject-action[data-variant="primary"]:disabled{opacity:.5;cursor:default}
.dsh-dialog-interject-action[data-variant="ghost"]{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsh-dialog-interject-action[data-variant="ghost"]:hover{background:var(--dsw-alias-bg-layer-2)}
.dsh-dialog-interject-action:disabled{cursor:default}
.dsh-dialog-interject-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4}
.dsh-dialog-interject-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-dialog-dialog{display:flex;flex-direction:column;flex:1 1 auto;height:100%;min-height:0;box-sizing:border-box;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary)}
.dsh-dialog-dialog-intro{flex:none;padding:10px 12px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsh-dialog-dialog-intro .dsh-dialog-dialog-reset{margin-top:6px;background:transparent;border:none;padding:0;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline}
.dsh-dialog-dialog-log{flex:1 1 0;min-height:0;overflow-y:auto;overflow-x:hidden;padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.dsh-dialog-dialog-compose{flex:none;border-top:1px solid var(--dsw-alias-border-l1);padding:9px 10px;display:flex;flex-direction:column;gap:7px;background:var(--dsw-alias-bg-layer-1)}
.dsh-dialog-dialog-empty{margin:auto;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center;line-height:1.6}
.dsh-dialog-dialog-msg{display:flex;flex-direction:row;align-items:flex-start;gap:8px;max-width:100%;flex:none}
.dsh-dialog-dialog-msg[data-role="user"]{flex-direction:row-reverse}
.dsh-dialog-dialog-avatar{flex:none;width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:600;line-height:1;user-select:none;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.dsh-dialog-dialog-msg[data-role="user"] .dsh-dialog-dialog-avatar{background:#95ec69;color:#111a0e;box-shadow:none}
.dsh-dialog-dialog-body{position:relative;max-width:calc(100% - 76px);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.55;padding:8px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.dsh-dialog-dialog-body::after{content:"";position:absolute;top:8px;width:0;height:0;border-top:5px solid transparent;border-bottom:5px solid transparent}
.dsh-dialog-dialog-msg[data-role="user"] .dsh-dialog-dialog-body{background:#95ec69;color:#111a0e;box-shadow:none;border-top-right-radius:3px}
.dsh-dialog-dialog-msg[data-role="user"] .dsh-dialog-dialog-body::after{right:-6px;border-left:6px solid #95ec69}
.dsh-dialog-dialog-msg[data-role="assistant"] .dsh-dialog-dialog-body{border-top-left-radius:3px}
.dsh-dialog-dialog-msg[data-role="assistant"] .dsh-dialog-dialog-body::after{left:-6px;border-right:6px solid var(--dsw-alias-bg-layer-2)}
.dsh-dialog-dialog-body strong{font-weight:600}
.dsh-dialog-dialog-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;padding:1px 4px;border-radius:4px;background:rgba(127,127,127,.18)}
.dsh-dialog-dialog-msg[data-role="user"] .dsh-dialog-dialog-body code{background:rgba(0,0,0,.13)}
.dsh-dialog-dialog-input{box-sizing:border-box;width:100%;min-height:62px;max-height:180px;resize:vertical;padding:8px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.dsh-dialog-dialog-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72}
.dsh-dialog-dialog-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-dialog-dialog-row{display:flex;align-items:center;gap:8px;white-space:nowrap}
.dsh-dialog-dialog-row .spacer{flex:1 1 auto}
.dsh-dialog-dialog-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4}
.dsh-dialog-dialog-status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dsh-dialog-dialog-gate{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:20px;text-align:center}
.dsh-dialog-dialog-gate p{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:260px}
.dsh-dialog-activity{display:flex;align-items:center;gap:7px;padding:4px 2px;font:inherit;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary);min-width:0}
.dsh-dialog-activity-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45}
.dsh-dialog-activity[data-tone="active"] .dsh-dialog-activity-dot{background:var(--dsw-alias-brand-primary);opacity:1;animation:dsh-dialog-activity-pulse 1.4s ease-in-out infinite}
.dsh-dialog-activity[data-tone="active"] .dsh-dialog-activity-text{color:var(--dsw-alias-label-primary)}
.dsh-dialog-activity[data-tone="done"] .dsh-dialog-activity-dot{background:var(--dsw-alias-state-success-primary);opacity:.8}
.dsh-dialog-activity-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
@keyframes dsh-dialog-activity-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.78)}}
`

    /** Install the shared stylesheet, keeping it in sync across reloads. */
    function ensureStyles() {
      const id = 'dsh-dialog-plugin-styles'
      const head = globalThis.document?.head
      if (head === undefined) return
      const existing = globalThis.document.getElementById(id)
      if (existing !== null) {
        // A style element with this id can outlive this module instance (the
        // client module is evaluated again on reload while the document keeps
        // the injected sheet). Leaving it alone would pin the page to whatever
        // rules the first evaluation shipped, so overwrite them instead.
        if (existing.textContent !== PANEL_CSS) existing.textContent = PANEL_CSS
        return
      }
      const style = globalThis.document.createElement('style')
      style.id = id
      style.textContent = PANEL_CSS
      head.appendChild(style)
    }

    /** The interject glyph: a speech mark entering a running line. */
    function InterjectIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M2.5 3.2h7.2a1.1 1.1 0 0 1 1.1 1.1v3.1a1.1 1.1 0 0 1-1.1 1.1H6.1L3.9 10.1a.5.5 0 0 1-.8-.4v-1.2h-.6a1.1 1.1 0 0 1-1.1-1.1V4.3a1.1 1.1 0 0 1 1.1-1.1Z',
          fill: 'currentColor',
          opacity: 0.9,
        }),
        h('path', {
          d: 'M10.4 8.2v1.5a.6.6 0 0 0 .6.6h2.1l1.3 1a.35.35 0 0 0 .55-.28v-.72h.15a.9.9 0 0 0 .9-.9V6.6',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        })
      )
    }

    /** The branch glyph: two speech bubbles, the smaller one set aside. */
    function DiscussionIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M1.8 3h6.6a1 1 0 0 1 1 1v3.2a1 1 0 0 1-1 1H4.9L3.1 9.6a.45.45 0 0 1-.72-.36V8.2h-.58a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
          fill: 'currentColor',
          opacity: 0.55,
        }),
        h('path', {
          d: 'M7.6 6.6h5.6a1 1 0 0 1 1 1v2.6a1 1 0 0 1-1 1H9.4l-1.5 1.3a.4.4 0 0 1-.66-.31V11.2h-.04a1 1 0 0 1-1-1V7.6a1 1 0 0 1 1-1Z',
          fill: 'currentColor',
        })
      )
    }

    /**
     * The composer tool-row control plus its popover.     * @param props - the slot inject face: `sessionId`, `useSession`.
     */
    function InterjectButton(props) {
      const { sessionId, useSession } = props
      // `useSession` is a snapshot selector over plain data — it carries no
      // submission methods. Only `sessionId` is needed here: the real
      // `SessionFace` comes from the sessions service in `sessionFace()`.
      const running = useSnapshotRunning(useSession)
      const language = detectLanguage()
      const sessions = useSessionsService()

      const [open, setOpen] = useState(false)
      const [draft, setDraft] = useState('')
      const [status, setStatus] = useState(undefined)
      const [pending, setPending] = useState(false)
      const [anchor, setAnchor] = useState(undefined)
      const buttonRef = useRef(null)
      const inputRef = useRef(null)

      useEffect(() => {
        ensureStyles()
      }, [])

      // Keep the popover glued above the button while it is open. The click that
      // opens it is a discrete event, so the ref is already attached and this
      // measures before the browser paints.
      useEffect(() => {
        if (!open) return undefined
        const place = () => {
          const node = buttonRef.current
          if (node === null || node === undefined) return
          const rect = node.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) return
          const left = Math.min(
            Math.max(8, rect.left + rect.width / 2 - PANEL_WIDTH / 2),
            Math.max(8, globalThis.innerWidth - PANEL_WIDTH - 8)
          )
          setAnchor({ left, bottom: Math.max(8, globalThis.innerHeight - rect.top + 8) })
        }
        place()
        globalThis.addEventListener('resize', place)
        globalThis.addEventListener('scroll', place, true)
        return () => {
          globalThis.removeEventListener('resize', place)
          globalThis.removeEventListener('scroll', place, true)
        }
      }, [open])

      // Escape closes; focus lands in the field.
      useEffect(() => {
        if (!open) return undefined
        const timer = globalThis.setTimeout(() => inputRef.current?.focus(), 0)
        const onKey = event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            setOpen(false)
          }
        }
        globalThis.addEventListener('keydown', onKey, true)
        return () => {
          globalThis.clearTimeout(timer)
          globalThis.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      const close = useCallback(() => {
        setOpen(false)
        setStatus(undefined)
      }, [])

      const submit = useCallback(async () => {
        const body = draft.trim()
        if (body === '') {
          setStatus({ tone: 'error', text: text(language, 'empty') })
          return
        }
        if (sessionId === undefined) {
          setStatus({ tone: 'error', text: text(language, 'failed', { reason: 'no session' }) })
          return
        }
        setPending(true)
        setStatus({ tone: 'info', text: text(language, 'sending') })
        try {
          const outcome = await deliverToSession(sessions, sessionId, body)
          if (outcome.ok) {
            setDraft('')
            setStatus({
              tone: 'info',
              text: text(language, outcome.mode === 'steer' ? 'sent' : 'queued'),
            })
          } else {
            setStatus({ tone: 'error', text: text(language, 'failed', { reason: outcome.reason }) })
          }
        } catch (error) {
          setStatus({ tone: 'error', text: text(language, 'failed', { reason: String(error?.message ?? error) }) })
        } finally {
          setPending(false)
        }
      }, [sessions, sessionId, draft, language])

      // The label never changes with the turn: a "(busy)" suffix made the
      // button resize under the cursor mid-sentence. The running state rides on
      // colour alone (`data-busy`), and the title explains why it lit up.
      const label = text(language, 'button')

      const trigger = h(
        'span',
        { className: 'dsh-dialog-interject-anchor' },
        h(
          'button',
          {
            type: 'button',
            ref: buttonRef,
            className: 'dsh-dialog-interject-button',
            title: text(language, running ? 'titleBusy' : 'title'),
            'aria-label': text(language, 'title'),
            'aria-expanded': open,
            'data-busy': running ? 'true' : 'false',
            onClick: () => {
              setStatus(undefined)
              setOpen(value => !value)
            },
          },
          h(InterjectIcon),
          h('span', null, label)
        )
      )

      // Nothing is laid out until the first measurement lands, so the bubble
      // never flashes at the untested origin.
      const popover =
        open && anchor !== undefined && globalThis.document !== undefined
          ? createPortal(
              h(
                'div',
                {
                  className: 'dsh-dialog-interject-popover',
                  style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` },
                  role: 'dialog',
                  'aria-label': text(language, 'title'),
                },
                h(
                  'div',
                  { className: 'dsh-dialog-interject-head' },
                  h('span', { className: 'dsh-dialog-interject-title' }, text(language, 'title')),
                  h('span', { className: 'spacer' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-dialog-interject-close',
                      title: text(language, 'cancel'),
                      'aria-label': text(language, 'cancel'),
                      onClick: close,
                    },
                    '×'
                  )
                ),
                h('div', { className: 'dsh-dialog-interject-hint' }, text(language, 'hint')),
                h('textarea', {
                  ref: inputRef,
                  className: 'dsh-dialog-interject-input',
                  value: draft,
                  placeholder: text(language, 'placeholder'),
                  disabled: pending,
                  onChange: event => setDraft(event.target.value),
                  onKeyDown: event => {
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault()
                      void submit()
                    }
                  },
                }),
                h(
                  'div',
                  { className: 'dsh-dialog-interject-row' },
                  status !== undefined
                    ? h(
                        'span',
                        { className: 'dsh-dialog-interject-status', 'data-tone': status.tone },
                        status.text
                      )
                    : h('span', { className: 'dsh-dialog-interject-status' }, ''),
                  h('span', { className: 'spacer' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-dialog-interject-action',
                      'data-variant': 'ghost',
                      onClick: close,
                    },
                    text(language, 'cancel')
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-dialog-interject-action',
                      'data-variant': 'primary',
                      disabled: pending,
                      onClick: () => void submit(),
                    },
                    pending ? text(language, 'sending') : text(language, 'send')
                  )
                )
              ),
              globalThis.document.body
            )
          : null

      return h(React.Fragment, null, trigger, popover)
    }

    //#endregion

    //#region Side discussion — right-hand tab on a forked branch

    /** Tab type discriminator; `openTab` names this value. */
    const TAB_KIND = 'dialog-branch'


    /**
     * Tool-row control that reveals the branch tab.
     *
     * The Sidebar only shows content while a session surface is mounted, so the
     * label also tells the user whether there is anything to talk about yet.
     *
     * @param props - slot props, including `sessionId` and `useSession`.
     */
    function SideDiscussionButton(props) {
      const sidebarRight = useSidebarRightService()
      const sessionId = props.sessionId
      const language = detectLanguage()
      const running = useSnapshotRunning(props.useSession)
      const [error, setError] = useState(undefined)

      const reveal = useCallback(() => {
        setError(undefined)
        try {
          if (sidebarRight === undefined || sidebarRight === null) {
            setError('sidebarRight service is missing')
            return
          }
          if (typeof sidebarRight.openTabIn === 'function') {
            sidebarRight.openTabIn(sessionId, TAB_KIND)
          } else if (typeof sidebarRight.openTab === 'function') {
            sidebarRight.openTab(TAB_KIND)
          } else {
            setError('sidebarRight has no openTab face')
            return
          }
          // The call is fire-and-forget and swallows an unadopted store, so ask
          // the service what it believes afterwards instead of assuming success.
          const tabs = sidebarRight.tabsIn?.(sessionId)
          if (Array.isArray(tabs) && !tabs.some(tab => tab.kind === TAB_KIND)) {
            setError('tab did not open — no adopted store for this session')
          }
        } catch (cause) {
          const message = String(cause?.message ?? cause)
          setError(message)
          globalThis.console?.warn?.('[dsh-dialog-plugin] could not open the branch tab:', cause)
        }
      }, [sidebarRight, sessionId])

      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-dialog-interject-button',
          'data-busy': running ? 'true' : 'false',
          title: error === undefined
            ? text(language, running ? 'panelToggleHintBusy' : 'panelToggleHint')
            : error,
          onClick: reveal,
        },
        h(DiscussionIcon, null),
        h('span', null, text(language, error === undefined ? 'panelOpen' : 'panelForkFailed', error === undefined ? undefined : { reason: error }))
      )
    }


    /** Tab implementation id: unique across every registration, and the body/title seat key. */
    const TAB_ID = 'dsh-dialog-plugin/branch'

    /** localStorage key prefix; one branch record per parent session. */
    const BRANCH_KEY_PREFIX = 'dsh-dialog-plugin.branch.'

    /**
     * Read the branch remembered for one parent session.
     *
     * The record is `{ id, from }`: the forked child and the child's first seq
     * at fork time. Events at or below `from` are the inherited parent history
     * and are hidden, because a discussion pane is a place to talk about the
     * fork, not a second view of the whole conversation.
     *
     * @param parentId - the parent session id.
     * @returns the stored record, or undefined.
     */
    function readBranch(parentId) {
      try {
        const raw = globalThis.localStorage?.getItem(BRANCH_KEY_PREFIX + parentId)
        if (typeof raw !== 'string' || raw === '') return undefined
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return undefined
        if (typeof parsed.id !== 'string' || parsed.id === '') return undefined
        const from = typeof parsed.from === 'number' && Number.isFinite(parsed.from) ? parsed.from : 0
        return { id: parsed.id, from }
      } catch {
        return undefined
      }
    }

    /**
     * Remember the branch for one parent session.
     * @param parentId - the parent session id.
     * @param record - the fork's id and its fork-time seq, or undefined to forget it.
     */
    function writeBranch(parentId, record) {
      try {
        if (record === undefined) globalThis.localStorage?.removeItem(BRANCH_KEY_PREFIX + parentId)
        else globalThis.localStorage?.setItem(BRANCH_KEY_PREFIX + parentId, JSON.stringify(record))
      } catch {
        // Private mode and quota failures only cost the branch its memory, not its life.
      }
    }

    /**
     * Read the highest durable seq present in one event window.
     *
     * Called right after the fork resolves: the child starts as an exact copy of
     * the parent, so its current tail is the boundary below which nothing new
     * has happened in this discussion yet.
     *
     * @param source - the child binding's event source.
     * @returns the highest seq, or 0 when the window is empty.
     */
    function tailSeqOf(source) {
      try {
        const entries = source?.getSnapshot()?.entries
        if (!Array.isArray(entries)) return 0
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const seq = entries[index]?.event?.seq
          if (typeof seq === 'number' && Number.isFinite(seq)) return seq
        }
      } catch {
        return 0
      }
      return 0
    }

    /**
     * Drop the injected `<system-reminder>` blocks from a message body.
     *
     * DSH appends workspace instructions and session facts to the first user
     * message as reminder blocks inside the same text part. The main chat keeps
     * them verbatim because the framing is part of what the model read, but a
     * discussion transcript only wants what the person actually typed.
     *
     * @param raw - the raw text of one message part.
     * @returns the text with every reminder block removed.
     */
    function stripReminders(raw) {
      if (typeof raw !== 'string' || raw === '') return ''
      return raw
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

    /**
     * Turn one session event into the lines worth showing in the branch log.
     *
     * Only user and assistant text is rendered; everything else (tool calls,
     * reasoning, lifecycle markers) is skipped, because this is a discussion
     * transcript, not the full conversation view.
     *
     * @param event - a `SessionEvent`.
     * @returns a role and text, or undefined when the event is not displayed.
     */
    function describeEvent(event) {
      if (event === undefined || event === null || typeof event !== 'object') return undefined
      const type = event.type
      const data = event.data
      if (data === undefined || data === null || typeof data !== 'object') return undefined
      const textOf = content => {
        if (!Array.isArray(content)) return ''
        return content
          .filter(part => part !== null && typeof part === 'object' && part.type === 'text')
          .map(part => (typeof part.text === 'string' ? part.text : ''))
          .join('\n')
      }
      if (type === 'user/message') {
        // Only `source.kind === 'user'` is a person typing. The Host also writes
        // context and reminder messages through this event — clock samples,
        // policy notices, skill catalogs — and those would drown the transcript.
        if (data.source?.kind !== 'user') return undefined
        const text = stripReminders(textOf(data.content ?? data.message?.content))
        return text === '' ? undefined : { role: 'user', text }
      }
      if (type === 'assistant/message') {
        const text = stripReminders(textOf(data.content ?? data.message?.content))
        return text === '' ? undefined : { role: 'assistant', text }
      }
      return undefined
    }

    /**
     * Read the visible messages out of a session event window.
     *
     * Only events strictly newer than `fromSeq` count: everything at or below it
     * was inherited from the parent at fork time, and a discussion pane that
     * replays the whole parent transcript is unusable.
     *
     * @param entries - `SessionEventWindow.entries`.
     * @param fromSeq - fork boundary; 0 shows the whole window.
     * @returns displayed messages in order, plus a short rejection tally.
     */
    function messagesFromEntries(entries, fromSeq = 0) {
      if (!Array.isArray(entries)) return { messages: [], stats: '' }
      const out = []
      const tally = new Map()
      for (const entry of entries) {
        if (entry === null || typeof entry !== 'object') continue
        if (entry.type !== 'event') continue
        const seq = typeof entry.event?.seq === 'number' ? entry.event.seq : 0
        if (seq <= fromSeq) continue
        const type = String(entry.event?.type ?? '?')
        const message = describeEvent(entry.event)
        if (message === undefined) {
          tally.set(type, (tally.get(type) ?? 0) + 1)
          continue
        }
        out.push(message)
      }
      const stats = [...tally.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 3)
        .map(([type, count]) => `${type}=${count}`)
        .join(' ')
      return { messages: out, stats }
    }

    /**
     * Subscribe to one session's event window through the sessions service.
     *
     * The window is the same source the conversation view reads, so the branch
     * transcript stays in step with the turn the Host is running.
     *
     * @param sessions - the `sessions` service.
     * @param sessionId - session to observe, or undefined.
     * @param fromSeq - hide every event at or below this seq (the fork boundary).
     * @returns messages, the running flag, and the revision currently on screen.
     */
    function useBranchLog(sessions, sessionId, fromSeq = 0) {
      const [messages, setMessages] = useState(() => [])
      const [running, setRunning] = useState(false)
      const [appliedRevision, setAppliedRevision] = useState(-1)
      const [entryStats, setEntryStats] = useState('')
      useEffect(() => {
        setMessages([])
        setRunning(false)
        setAppliedRevision(-1)
        setEntryStats('')
        if (sessions === undefined || sessions === null || sessionId === undefined) return undefined
        let binding
        let borrowed
        try {
          binding = sessions.binding?.(sessionId)
          if (binding === undefined) {
            // The sidebar keeps the branch id in storage across reloads, but the
            // retained reference died with the old page. Borrow one so the
            // transcript can be read; it is handed back when the tab unmounts.
            borrowed = sessions.retain?.(sessionId, { source: 'gateway' })
            binding = borrowed?.binding
          }
        } catch {
          binding = undefined
        }
        if (binding === undefined) return undefined
        const face = binding.session
        const readFace = () => {
          try {
            setRunning(face.getSnapshot()?.running === true)
          } catch {
            setRunning(false)
          }
        }
        readFace()
        const offFace = face.subscribe?.(readFace)
        const source = binding.eventSource
        // The window snapshot is mutated in place, so comparing it to itself would
        // never notice the append. The published `revision` is the only field that
        // changes, and it is the contract's own "latest synchronous delta" marker.
        let lastRevision = -1
        const readSource = () => {
          try {
            const window = source.getSnapshot()
            const revision = typeof window?.revision === 'number' ? window.revision : -1
            if (revision === lastRevision) return
            lastRevision = revision
            const read = messagesFromEntries(window?.entries, fromSeq)
            setMessages(read.messages)
            setEntryStats(`${revision} · ${read.messages.length} 条 >${fromSeq}${read.stats === '' ? '' : ' · ' + read.stats}`)
            setAppliedRevision(revision)
          } catch {
            setMessages([])
            setEntryStats('read failed')
          }
        }
        readSource()
        const offSource = source.subscribe?.(readSource)
        // Frames the source refuses to publish (a missed append, a reconnected
        // transport) would otherwise leave the transcript frozen, so the window is
        // re-read on a slow beat; the revision guard keeps that read free.
        const view = globalThis
        const settle = view.setInterval?.(readSource, 1000)
        return () => {
          if (typeof offFace === 'function') offFace()
          if (typeof offSource === 'function') offSource()
          if (settle !== undefined) view.clearInterval?.(settle)
          if (borrowed !== undefined) {
            try {
              borrowed.release?.()
            } catch {
              // A reference already reclaimed by the service needs no second release.
            }
          }
        }
      }, [sessions, sessionId, fromSeq])
      return { messages, running, appliedRevision, entryStats }
    }

    /**
     * The right-sidebar body: a branch conversation with its own composer.
     *
     * Gets `sessionId` from the slot's standard props — the *parent* session the
     * sidebar belongs to — and works on a child forked from it, so the sidebar's
     * own session surface is left alone.
     *
     * @param props - slot props, including `sessionId`.
     */
    function SideDiscussionTab(props) {
      const sessions = useSessionsService()
      const parentId = props.sessionId
      const language = detectLanguage()
      const [branch, setBranch] = useState(() => (parentId === undefined ? undefined : readBranch(parentId)))
      const branchId = branch?.id
      const fromSeq = branch?.from ?? 0
      const [phase, setPhase] = useState('ready')
      const [failure, setFailure] = useState('')
      const [draft, setDraft] = useState('')
      const [status, setStatus] = useState(undefined)
      const rootRef = React.useRef(null)
      const { messages, running, appliedRevision, entryStats } = useBranchLog(sessions, branchId, fromSeq)

      /** Create the branch if it does not exist yet. */
      const startBranch = useCallback(async () => {
        if (sessions === undefined || sessions === null || parentId === undefined) {
          setPhase('error')
          setFailure(
            sessions === undefined || sessions === null
              ? 'the sessions service is not reachable from the sidebar tab'
              : text(language, 'panelNeedSession')
          )
          return
        }
        setPhase('starting')
        setFailure('')
        try {
          let childId
          await sessions.fork({
            sessionId: parentId,
            increaseTitle: true,
            onCreated: created => {
              childId = created
            },
          })
          if (childId === undefined) throw new Error('fork returned no child id')
          // The child starts as an exact copy of the parent, so its tail right
          // after the fork is the boundary below which everything is inherited.
          // Retain once here only to read that tail, then hand it straight back.
          let from = 0
          try {
            const probe = sessions.retain?.(childId, { source: 'gateway' })
            if (probe !== undefined) {
              try {
                from = tailSeqOf(probe.binding?.eventSource)
              } finally {
                probe.release?.()
              }
            }
          } catch {
            from = 0
          }
          writeBranch(parentId, { id: childId, from })
          // The transcript hook borrows its own reference, so nothing is held here.
          setBranch({ id: childId, from })
          setPhase('ready')
          return childId
        } catch (error) {
          const message = String(error?.message ?? error)
          // `session/fork-unavailable` means the parent has never finished a
          // turn, so there is no history point to branch from. That is a
          // transient state of a session that is still working, not a fault.
          const waiting = message.includes('fork-unavailable')
          setPhase(waiting ? 'waiting' : 'error')
          setFailure(waiting ? text(language, 'panelWaitTurn') : message)
          globalThis.console?.warn?.('[dsh-dialog-plugin] could not fork the discussion branch:', error)
          return undefined
        }
      }, [sessions, parentId, language])

      /** Fork again from the latest progress, discarding the old branch record. */
      const resetBranch = useCallback(() => {
        if (parentId !== undefined) writeBranch(parentId, undefined)
        setBranch(undefined)
        setStatus(undefined)
        setDraft('')
        setPhase('ready')
      }, [parentId])

      // No auto-fork on mount: every reload would otherwise leave one more
      // forked session behind in the sidebar. A branch is created only when the
      // reader asks for one, and its id is remembered per parent session.

      /** Send the draft into the branch and clear the composer. */
      const send = useCallback(async () => {
        const body = draft.trim()
        if (body === '') {
          setStatus({ tone: 'error', text: text(language, 'empty') })
          return
        }
        if (branchId === undefined) return
        setStatus({ tone: 'info', text: text(language, 'sending') })
        try {
          const outcome = await deliverToSession(sessions, branchId, body, 'queue')
          if (outcome.ok) {
            setDraft('')
            setStatus(undefined)
          } else {
            setStatus({ tone: 'error', text: text(language, 'failed', { reason: outcome.reason }) })
          }
        } catch (error) {
          setStatus({ tone: 'error', text: text(language, 'failed', { reason: String(error?.message ?? error) }) })
        }
      }, [sessions, branchId, draft, language])

      const onKeyDown = event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void send()
        }
      }

      const header = h(
        'div',
        { className: 'dsh-dialog-dialog-intro' },
        text(language, 'panelIntro'),
        branchId === undefined
          ? null
          : h(
              'div',
              null,
              h(
                'button',
                { type: 'button', className: 'dsh-dialog-dialog-reset', onClick: resetBranch },
                text(language, 'panelReset')
              )
            )
      )

      if (branchId === undefined) {
        const waiting = phase === 'waiting'
        return h(
          'div',
          { className: 'dsh-dialog-dialog' },
          h(
            'div',
            { className: 'dsh-dialog-dialog-gate' },
            h(
              'p',
              { 'data-tone': phase === 'error' ? 'error' : undefined },
              waiting
                ? text(language, 'panelWaitTurn')
                : phase === 'error'
                  ? text(language, 'panelFailed', { reason: failure })
                  : text(language, 'panelIntro')
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-dialog-interject-action',
                'data-variant': 'primary',
                disabled: phase === 'starting',
                onClick: () => void startBranch(),
              },
              text(language, waiting ? 'panelRetry' : phase === 'starting' ? 'panelStarting' : 'panelStart')
            )
          )
        )
      }

      const rows = messages.map((message, index) =>
        h(
          'div',
          { key: `${index}-${message.role}`, className: 'dsh-dialog-dialog-msg', 'data-role': message.role },
          h(
            'div',
            {
              className: 'dsh-dialog-dialog-avatar',
              title: text(language, message.role === 'user' ? 'panelYou' : 'panelAgent'),
              'aria-hidden': 'true',
            },
            text(language, message.role === 'user' ? 'panelYou' : 'panelAgent').slice(0, 1)
          ),
          h('div', { className: 'dsh-dialog-dialog-body' }, renderInline(message.text))
        )
      )
      if (running) {
        rows.push(
          h(
            'div',
            { key: 'running', className: 'dsh-dialog-dialog-msg', 'data-role': 'assistant' },
            h(
              'div',
              { className: 'dsh-dialog-dialog-avatar', title: text(language, 'panelAgent'), 'aria-hidden': 'true' },
              text(language, 'panelAgent').slice(0, 1)
            ),
            h('div', { className: 'dsh-dialog-dialog-body' }, text(language, 'panelWait'))
          )
        )
      }

      return h(
        'div',
        {
          className: 'dsh-dialog-dialog',
          ref: rootRef,
        },
        header,
        h(
          'div',
          {
            className: 'dsh-dialog-dialog-log',
            'data-empty': rows.length === 0,
          },
          rows.length === 0 ? h('div', { className: 'dsh-dialog-dialog-empty' }, text(language, 'panelEmpty')) : rows
        ),
        h(
          'div',
          { className: 'dsh-dialog-dialog-compose' },
          h('textarea', {
            className: 'dsh-dialog-dialog-input',
            value: draft,
            placeholder: text(language, 'panelPlaceholder'),
            onChange: event => setDraft(event.target.value),
            onKeyDown,
          }),
          h(
            'div',
            { className: 'dsh-dialog-dialog-row' },
            status === undefined
              ? null
              : h(
                  'span',
                  { className: 'dsh-dialog-dialog-status', 'data-tone': status.tone },
                  status.text
                ),
            h('span', { className: 'spacer' }),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-dialog-interject-action',
                'data-variant': 'primary',
                disabled: draft.trim() === '',
                onClick: () => void send(),
              },
              text(language, 'panelSend')
            )
          )
        )
      )
    }

    //#endregion

    //#region Plugin entry

    /**
     * Slot components receive props, not the cordis context, so the one service
     * they need beyond those props travels down through this carrier.
     */
    const Services = React.createContext(undefined)

    /**
     * Read the `sessions` service handed down by `apply`.
     * @returns the service, or undefined outside the carrier.
     */
    function useSessionsService() {
      return React.useContext(Services)?.sessions
    }

    /**
     * Read the right-Sidebar service handed down by `apply`.
     * @returns the service, or undefined when the Sidebar domain is absent.
     */
    function useSidebarRightService() {
      return React.useContext(Services)?.sidebarRight
    }

    /** Required client services: slots to register into, sessions for scope. */
    const inject = ['slots', 'sessions']

    /**
     * Mount the client half.
     * @param ctx - the client cordis context.
     */
    function apply(ctx) {
      ensureStyles()
      // The right-Sidebar service is provided by a sibling package, so it may
      // arrive after this plugin applies. `services` is therefore mutable: the
      // late injection below fills it in, and the carrier object itself never
      // changes identity (so the Provider never re-renders on that account).
      const services = { sessions: ctx.get('sessions'), sidebarRight: ctx.get('sidebarRight') }
      // Both peer services may arrive after this plugin applies, so resolve them
      // through late injection as well; the carrier object keeps its identity.
      ctx.inject(['sessions'], injected => {
        const late = injected.get('sessions')
        if (late !== undefined) services.sessions = late
      })
      ctx.inject(['sidebarRight'], injected => {
        const late = injected.get('sidebarRight')
        if (late !== undefined) services.sidebarRight = late
      })
      // Wrap every registered component so it can reach the service above.
      const withServices = Component => function ServiceBound(props) {
        return h(Services.Provider, { value: services }, h(Component, props))
      }

      // Register the copy so `t()` lookups work for anything that wants them;
      // the components below read DICT directly and work without a locale face.
      ctx.inject?.(['locale'], scope => {
        scope.effect(() => {
          const offZh = scope.locale.register(NS, 'zh', DICT.zh)
          const offEn = scope.locale.register(NS, 'en', DICT.en)
          return () => {
            offZh()
            offEn()
          }
        }, 'dsh-dialog-plugin: dictionaries')
      })

      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'dsh-dialog-interject',
            order: 40,
          },
          withServices(InterjectButton)
        )
      )

      // The right Sidebar is a sibling domain: register a tab type there and its
      // body, then put a control in the composer's action row so the tab can be
      // opened from the conversation it belongs to. `register` already owns the
      // effect that tears the type down, so it is called directly.
      ctx.inject(['sidebarRightTabs'], injected => {
        const tabs = injected.get('sidebarRightTabs')
        if (tabs === undefined) {
          globalThis.console?.warn?.('[dsh-dialog-plugin] sidebarRightTabs is not reachable')
          return
        }
        // The registry lives on the sidebar-right package context, which outlives
        // a page reload, so a type registered by an earlier generation of this
        // plugin is still in force after F5. A second registration of the same id
        // throws and would leave the body seat pointing at a stale definition, so
        // the conflict is caught and the existing registration is left alone.
        try {
          tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            keepMounted: true,
            priority: 'extension',
            title: () => text(detectLanguage(), 'panelTitle'),
            guide: [
              {
                id: TAB_ID,
                order: 200,
                title: () => text(detectLanguage(), 'panelTitle'),
                description: () => text(detectLanguage(), 'panelIntro'),
              },
            ],
          })
        } catch (error) {
          const message = String(error?.message ?? error)
          if (!message.includes('is already registered')) {
            globalThis.console?.warn?.('[dsh-dialog-plugin] could not register the tab type:', error)
          }
        }
      })

      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
          },
          withServices(SideDiscussionTab)
        )
      )

      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'dsh-dialog-open-branch',
            order: 50,
          },
          withServices(SideDiscussionButton)
        )
      )

      // The status line sits in the dock above the composer card. The dock below
      // it already carries the harness' own tool line, so a second one there
      // would say the same thing twice.
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'dsh-dialog-activity',
            order: 5,
          },
          withServices(ActivityLine)
        )
      )

      // Its switch lives in the tool row next to the other two controls, before
      // them so the row still reads "what I can do" then "what I send".
      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'dsh-dialog-activity-switch',
            order: 30,
          },
          withServices(ActivityToggle)
        )
      )
    }

    return { inject, apply }

    //#endregion
  },
})
