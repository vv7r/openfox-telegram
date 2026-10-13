import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkMessage,
  cleanBotToken,
  normalizeUserId,
  OpenFoxRestClient,
  TelegramClient,
  Conversation,
  register,
  BOT_COMMANDS,
  BOT_COMMANDS_EN,
  registerBotCommands,
  createRuntime,
  KEYS,
  markdownToTelegramHtml,
  toAttachment,
  configFilePort,
  FileChanges,
  createWsSubscribe,
  resolveBaseUrl,
  statusPanelContent,
  deactivate,
} from './index.js'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const RUNTIME_KEY = Symbol.for('openfox-telegram-runtime')
const MODULE_URL = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'index.js')).href
async function importFreshModule() {
  // Simulate OpenFox's cache-bust re-import (?v=...): a fresh ESM module
  // instance each call, so the module-scoped `runtime` is NOT shared.
  return import(`${MODULE_URL}?v=${Date.now()}-${Math.random()}`)
}

// A fake Telegram client that records sent messages and answered callbacks,
// and can be driven with _push to simulate incoming updates.
function fakeTelegram() {
  const sent = []
  const answered = []
  const updates = []
  return {
    sent,
    answered,
    async sendMessage(chatId, text, extra) {
      sent.push({ chatId, text, extra })
    },
    async sendChatAction() {},
    async answerCallbackQuery(id) {
      answered.push(id)
    },
    async getUpdates() {
      if (updates.length === 0) {
        // Simulate the long-poll: wait a bit when there are no updates,
        // so the poll loop does not busy-spin and keep the process alive.
        await sleep(50)
      }
      return updates.splice(0)
    },
    async setMyCommands() {},
    abort() {},
    _push(u) {
      updates.push(u)
    },
  }
}

// A controllable fake timer so the typing-indicator tick and the turn
// watchdog timeout are deterministic.
function fakeTimer() {
  const intervals = []
  const timeouts = []
  return {
    setInterval: (fn) => {
      intervals.push(fn)
      return intervals.length
    },
    clearInterval: (id) => {
      intervals[id - 1] = undefined
    },
    _tick: (id) => {
      intervals[id - 1]?.()
    },
    setTimeout: (fn) => {
      timeouts.push(fn)
      return timeouts.length
    },
    clearTimeout: (id) => {
      timeouts[id - 1] = undefined
    },
    _fireTimeout: (id) => {
      timeouts[id - 1]?.()
    },
  }
}

// A fake `subscribe(sessionId, onEvent) => cleanup` that records the handler
// so tests can drive scripted server messages.
function fakeSubscribe() {
  const registered = []
  const subscribe = (sessionId, onEvent) => {
    registered.push({ sessionId, onEvent })
    return () => {
      registered.length = 0
    }
  }
  return { subscribe, registered }
}

// ---------------------------------------------------------------------------
// chunkMessage
// ---------------------------------------------------------------------------

test('chunkMessage keeps a short message intact', () => {
  assert.deepEqual(chunkMessage('hello'), ['hello'])
})

test('chunkMessage splits a long message into chunks of at most 4096 chars', () => {
  const text = 'a'.repeat(10000)
  const chunks = chunkMessage(text)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.length <= 4096)
  // Nothing is lost: reassembling the chunks reproduces the input.
  assert.equal(chunks.join(''), text)
})

test('chunkMessage prefers to break on newlines', () => {
  const text = 'line1\nline2\n' + 'x'.repeat(5000)
  const chunks = chunkMessage(text)
  assert.ok(chunks.length >= 2)
  for (const c of chunks) assert.ok(c.length <= 4096)
  assert.equal(chunks.join(''), text)
})

// ---------------------------------------------------------------------------
// cleanBotToken — strip accidental surrounding quotes/whitespace from a
// settings value (a token copy-pasted as a JSON string comes in quoted).
// ---------------------------------------------------------------------------

test('cleanBotToken strips surrounding quotes and whitespace', () => {
  assert.equal(cleanBotToken('"123:ABC"'), '123:ABC')
  assert.equal(cleanBotToken(" 123:ABC "), '123:ABC')
  assert.equal(cleanBotToken("'123:ABC'"), '123:ABC')
  assert.equal(cleanBotToken('" 123:ABC "'), '123:ABC')
  assert.equal(cleanBotToken('123:ABC'), '123:ABC')
  assert.equal(cleanBotToken(''), '')
  assert.equal(cleanBotToken(undefined), '')
  assert.equal(cleanBotToken(null), '')
})

// ---------------------------------------------------------------------------
// normalizeUserId — a settings value for the authorized Telegram user ID is a
// string; the Bot API compares it against an integer user id. Normalize to a
// number (or null when unset/invalid) so the comparison works.
// ---------------------------------------------------------------------------

test('normalizeUserId returns a number for a numeric string', () => {
  assert.equal(normalizeUserId('12345'), 12345)
  assert.equal(normalizeUserId(' 12345 '), 12345)
})

test('normalizeUserId returns null for empty/whitespace/non-numeric/unset', () => {
  assert.equal(normalizeUserId(''), null)
  assert.equal(normalizeUserId('   '), null)
  assert.equal(normalizeUserId('abc'), null)
  assert.equal(normalizeUserId(undefined), null)
  assert.equal(normalizeUserId(null), null)
})

// ---------------------------------------------------------------------------
// OpenFoxRestClient
// ---------------------------------------------------------------------------

test('OpenFoxRestClient.listProjects GETs /api/projects and returns projects', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ projects: [{ id: 'p1' }] }) }
    },
  })
  const projects = await client.listProjects()
  assert.deepEqual(projects, [{ id: 'p1' }])
  assert.ok(calls[0][0].includes('/api/projects'))
  assert.equal(calls[0][1].method, 'GET')
})

test('OpenFoxRestClient.createProject POSTs {name, workdir}', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 201, json: async () => ({ project: { id: 'p2' } }) }
    },
  })
  const project = await client.createProject('Demo', '/tmp/demo')
  assert.deepEqual(project, { id: 'p2' })
  const [url, opts] = calls[0]
  assert.ok(url.includes('/api/projects'))
  assert.equal(opts.method, 'POST')
  assert.deepEqual(JSON.parse(opts.body), { name: 'Demo', workdir: '/tmp/demo' })
})

test('OpenFoxRestClient.listSessions GETs /api/sessions?projectId=', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ sessions: [{ id: 's1' }, { id: 's2' }] }) }
    },
  })
  const sessions = await client.listSessions('p1')
  assert.deepEqual(sessions, [{ id: 's1' }, { id: 's2' }])
  const [url] = calls[0]
  assert.ok(url.includes('/api/sessions'))
  assert.ok(url.includes('projectId=p1'))
})

test('OpenFoxRestClient.createSession POSTs {projectId, title}', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 201, json: async () => ({ session: { id: 's3' } }) }
    },
  })
  const session = await client.createSession('p1', 'My session')
  assert.deepEqual(session, { id: 's3' })
  const [url, opts] = calls[0]
  assert.ok(url.endsWith('/api/sessions'))
  assert.equal(opts.method, 'POST')
  assert.deepEqual(JSON.parse(opts.body), { projectId: 'p1', title: 'My session' })
})

test('OpenFoxRestClient.sendMessage POSTs {content} to /api/sessions/:id/message', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ success: true }) }
    },
  })
  const res = await client.sendMessage('s1', 'hello')
  assert.deepEqual(res, { success: true })
  const [url, opts] = calls[0]
  assert.ok(url.includes('/api/sessions/s1/message'))
  assert.equal(opts.method, 'POST')
  assert.deepEqual(JSON.parse(opts.body), { content: 'hello' })
})

test('OpenFoxRestClient.listAgents GETs /api/agents and returns the defaults', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return {
        status: 200,
        json: async () => ({
          defaults: [
            { id: 'builder', name: 'Builder', description: 'Implements the task' },
            { id: 'planner', name: 'Planner', description: 'Defines criteria' },
          ],
        }),
      }
    },
  })
  const agents = await client.listAgents()
  assert.deepEqual(agents, [
    { id: 'builder', name: 'Builder', description: 'Implements the task' },
    { id: 'planner', name: 'Planner', description: 'Defines criteria' },
  ])
  const [url, opts] = calls[0]
  assert.ok(url.endsWith('/api/agents'))
  assert.equal(opts.method, 'GET')
})

test('OpenFoxRestClient.setSessionMode PUTs {mode} to /api/sessions/:id/mode', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ session: { id: 's1', mode: 'builder' } }) }
    },
  })
  const session = await client.setSessionMode('s1', 'builder')
  assert.deepEqual(session, { id: 's1', mode: 'builder' })
  const [url, opts] = calls[0]
  assert.ok(url.endsWith('/api/sessions/s1/mode'))
  assert.equal(opts.method, 'PUT')
  assert.deepEqual(JSON.parse(opts.body), { mode: 'builder' })
})

// ---------------------------------------------------------------------------
// TelegramClient
// ---------------------------------------------------------------------------

test('TelegramClient.sendMessage chunks a long message into several calls', async () => {
  const calls = []
  const client = new TelegramClient({
    token: 'T',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ ok: true, result: {} }) }
    },
  })
  const text = 'a'.repeat(9000)
  await client.sendMessage('c1', text)
  assert.ok(calls.length >= 3)
  for (const [, opts] of calls) {
    const body = JSON.parse(opts.body)
    assert.equal(body.chat_id, 'c1')
    assert.ok(body.text.length <= 4096)
  }
  assert.equal(calls.map(([, o]) => JSON.parse(o.body).text).join(''), text)
})

test('TelegramClient.sendChatAction posts action typing', async () => {
  const calls = []
  const client = new TelegramClient({
    token: 'T',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ ok: true, result: true }) }
    },
  })
  const res = await client.sendChatAction('c1', 'typing')
  assert.equal(res, true)
  const [url, opts] = calls[0]
  assert.ok(url.includes('/botT/sendChatAction'))
  assert.deepEqual(JSON.parse(opts.body), { chat_id: 'c1', action: 'typing' })
})

test('TelegramClient strips surrounding quotes from the token in the URL', async () => {
  const calls = []
  const client = new TelegramClient({
    token: '"T"',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ ok: true, result: true }) }
    },
  })
  await client.sendChatAction('c1', 'typing')
  const [url] = calls[0]
  // The URL must use the cleaned token (no quotes), otherwise the Bot API
  // returns 404 and every call (typing indicator included) silently fails.
  assert.ok(url.includes('/botT/sendChatAction'))
  assert.ok(!url.includes('"'))
})

test('TelegramClient.getUpdates posts offset and timeout', async () => {
  const calls = []
  const client = new TelegramClient({
    token: 'T',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ ok: true, result: [] }) }
    },
  })
  const res = await client.getUpdates(42, 30)
  assert.deepEqual(res, [])
  const [url, opts] = calls[0]
  assert.ok(url.endsWith('/botT/getUpdates'))
  assert.deepEqual(JSON.parse(opts.body), { offset: 42, timeout: 30 })
})

// ---------------------------------------------------------------------------
// Telegram command menu (setMyCommands)
// ---------------------------------------------------------------------------

test('BOT_COMMANDS lists the bot commands with descriptions', () => {
  assert.ok(Array.isArray(BOT_COMMANDS))
  assert.ok(BOT_COMMANDS.length >= 3)
  for (const c of BOT_COMMANDS) {
    assert.ok(typeof c.command === 'string' && c.command.length > 0)
    assert.ok(typeof c.description === 'string' && c.description.length > 0)
    // Telegram expects command names without the leading "/".
    assert.ok(!c.command.startsWith('/'))
  }
  const cmds = BOT_COMMANDS.map((c) => c.command)
  for (const expected of ['start', 'stop', 'agents']) {
    assert.ok(cmds.includes(expected), `missing command: ${expected}`)
  }
})

test('TelegramClient.setMyCommands posts the command list', async () => {
  const calls = []
  const client = new TelegramClient({
    token: 'T',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ ok: true, result: true }) }
    },
  })
  const res = await client.setMyCommands([{ command: 'start', description: 'List projects' }])
  assert.equal(res, true)
  const [url, opts] = calls[0]
  assert.ok(url.endsWith('/botT/setMyCommands'))
  const body = JSON.parse(opts.body)
  assert.deepEqual(body.commands, [{ command: 'start', description: 'List projects' }])
})

test('registerBotCommands calls telegram.setMyCommands with BOT_COMMANDS', async () => {
  const calls = []
  const telegram = { setMyCommands: async (commands, opts) => { calls.push({ commands, opts }) } }
  await registerBotCommands(telegram, noopLogger)
  assert.equal(calls.length, 2, 'French by default, then English')
  assert.deepEqual(calls[0], { commands: BOT_COMMANDS, opts: {} })
  assert.equal(calls[1].opts.languageCode, 'en')
})

test('registerBotCommands swallows errors (non-fatal)', async () => {
  const telegram = { setMyCommands: async () => { throw new Error('boom') } }
  // Must not throw even if the Bot API fails.
  await registerBotCommands(telegram, noopLogger)
})

// ---------------------------------------------------------------------------
// Conversation — forwarding a turn
// ---------------------------------------------------------------------------

test('runTurn forwards only accumulated chat.delta, NOT thinking', async () => {
  const sent = []
  const restCalls = []
  const telegram = {
    sendMessage: async (chatId, text) => {
      sent.push(text)
    },
    sendChatAction: async () => {},
  }
  const rest = {
    sendMessage: async (sessionId, content) => {
      restCalls.push([sessionId, content])
    },
  }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'hello')
  const { sessionId, onEvent } = registered[0]
  assert.equal(sessionId, 's1')

  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'He' } })
  onEvent({ type: 'chat.thinking', payload: { messageId: 'm1', content: 'SECRET THINKING' } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'llo ' } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'world' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  // Only the assistant text is forwarded; thinking is never sent.
  assert.deepEqual(sent, ['Hello world'])
  assert.ok(!sent.join('').includes('SECRET THINKING'))
  assert.deepEqual(restCalls, [['s1', 'hello']])
})

test('runTurn accumulates deltas per messageId and ignores sub-agent deltas', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'x')
  const { onEvent } = registered[0]
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'main ', subAgentType: 'explorer' } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'answer' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  assert.deepEqual(sent, ['answer'])
})

test('runTurn sends a typing indicator while the turn is in progress', async () => {
  const typing = []
  const sent = []
  const telegram = {
    sendMessage: async (c, t) => sent.push(t),
    sendChatAction: async (chatId, action) => {
      typing.push([chatId, action])
    },
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const timer = fakeTimer()
  const conv = new Conversation({
    chatId: 'c1',
    telegram,
    rest,
    subscribe,
    logger: noopLogger,
    timer,
  })

  const p = conv.runTurn('s1', 'x')
  const { onEvent } = registered[0]
  // Simulate the periodic tick firing while the turn is still running.
  timer._tick(1)
  timer._tick(1)
  assert.ok(typing.length >= 2)
  for (const [chatId, action] of typing) {
    assert.equal(chatId, 'c1')
    assert.equal(action, 'typing')
  }
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'ok' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p
  assert.deepEqual(sent, ['ok'])
  // After done, further ticks no longer call sendChatAction (interval cleared).
  const before = typing.length
  timer._tick(1)
  assert.equal(typing.length, before)
})

test('startTyping logs a warning when sendChatAction fails (not swallowed)', async () => {
  const warnings = []
  const logger = {
    debug() {},
    info() {},
    warn: (msg) => warnings.push(String(msg)),
    error() {},
  }
  const telegram = {
    sendChatAction: async () => {
      throw new Error('telegram 404: Not Found')
    },
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram,
    rest: { sendMessage: async () => {} },
    subscribe: fakeSubscribe().subscribe,
    logger,
    timer: fakeTimer(),
  })
  const stop = conv.startTyping()
  // Let the immediate (rejected) sendChatAction settle.
  await new Promise((r) => setTimeout(r, 20))
  stop()
  assert.ok(
    warnings.some((w) => w.includes('failed')),
    `expected a "failed" warning, got: ${JSON.stringify(warnings)}`,
  )
})

test('startTyping logs success (at debug level) when sendChatAction resolves', async () => {
  const infos = []
  const logger = {
    debug: (msg) => infos.push(String(msg)),
    info() {},
    warn() {},
    error() {},
  }
  const telegram = { sendChatAction: async () => true }
  const conv = new Conversation({
    chatId: 'c1',
    telegram,
    rest: { sendMessage: async () => {} },
    subscribe: fakeSubscribe().subscribe,
    logger,
    timer: fakeTimer(),
  })
  const stop = conv.startTyping()
  await new Promise((r) => setTimeout(r, 20))
  stop()
  assert.ok(infos.some((w) => w.includes('sent')), `expected a "sent" debug log, got: ${JSON.stringify(infos)}`)
})

test('runTurn stops the typing indicator and does not forward after chat.done', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const timer = fakeTimer()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger, timer })

  const p = conv.runTurn('s1', 'x')
  const { onEvent } = registered[0]
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'done' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  // Late deltas after completion must not be forwarded.
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'LATE' } })
  await p
  assert.deepEqual(sent, ['done'])
})

test('runTurn stops after chat.done with reason step_done', async () => {
  const sent = []
  const typing = []
  const telegram = {
    sendMessage: async (c, t) => sent.push(t),
    sendChatAction: async (c, a) => typing.push(a),
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const timer = fakeTimer()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger, timer, typingIntervalMs: 100 })

  const p = conv.runTurn('s1', 'x')
  const { onEvent } = registered[0]
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'hello' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'step_done' } })
  await p
  assert.deepEqual(sent, ['hello'])
})

test('runTurn forwards a chat.error message to Telegram', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'x')
  const { onEvent } = registered[0]
  onEvent({ type: 'chat.error', payload: { error: 'boom', recoverable: false } })
  await p
  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes('boom'))
})

test('runTurn times out gracefully when chat.done never arrives (watchdog)', async () => {
  const sent = []
  const warnings = []
  const logger = {
    debug() {},
    info() {},
    warn: (m) => warnings.push(String(m)),
    error() {},
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe } = fakeSubscribe()
  const timer = fakeTimer()
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe,
    logger,
    timer,
    turnTimeoutMs: 100,
  })
  // Start a turn and never emit chat.done. Fire the watchdog timeout.
  const p = conv.runTurn('s1', 'x')
  timer._fireTimeout(1)
  await p
  assert.ok(
    sent.some((t) => t.toLowerCase().includes('expiré')),
    `expected a French timeout message, got: ${JSON.stringify(sent)}`,
  )
  assert.ok(warnings.some((w) => w.includes('timed out')), 'expected a timeout warning')
})

test('runTurn survives a compaction done and forwards the final answer', async () => {
  const sent = []
  const rest = { sendMessage: async () => {}, stopSession: async () => ({ success: true }) }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe,
    logger: noopLogger,
  })
  const p = conv.handleText('/send s1 reponds apres compaction')
  assert.ok(await until(() => registered.length > 0), 'the turn should have subscribed')
  const onEvent = registered[0].onEvent

  // The server emits the compaction summary (chat.message isCompactionSummary),
  // then a chat.done for the compaction turn, then the agent continues and
  // emits the real answer.
  onEvent({ type: 'chat.message', payload: { message: { id: 'sum', role: 'assistant', content: 'RÉSUMÉ DE COMPACTION', isCompactionSummary: true } } })
  onEvent({ type: 'chat.done', payload: { messageId: 'sum', reason: 'complete' } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'a1', content: 'voici la réponse finale.' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'a1', reason: 'complete' } })
  await p

  // The real answer is relayed.
  assert.ok(
    sent.some((t) => t.includes('voici la réponse finale')),
    `expected the final answer after the compaction done, got: ${JSON.stringify(sent)}`,
  )
  // The compaction summary is NOT relayed as a normal answer.
  assert.ok(
    !sent.some((t) => t.includes('RÉSUMÉ DE COMPACTION')),
    `compaction summary must not be sent to Telegram, got: ${JSON.stringify(sent)}`,
  )
})

test('runTurn still ends on a plain chat.done when no compaction preceded it', async () => {
  const sent = []
  const rest = { sendMessage: async () => {}, stopSession: async () => ({ success: true }) }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe,
    logger: noopLogger,
  })
  const p = conv.handleText('/send s1 reponse simple')
  assert.ok(await until(() => registered.length > 0), 'the turn should have subscribed')
  const onEvent = registered[0].onEvent

  // No compaction: a single chat.done must end the turn and relay the text.
  onEvent({ type: 'chat.delta', payload: { messageId: 'a1', content: 'reponse simple' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'a1', reason: 'complete' } })
  await p

  assert.ok(sent.some((t) => t.includes('reponse simple')), `expected the plain answer, got: ${JSON.stringify(sent)}`)
})

test('the follow-mode watcher does not forward the compaction summary', async () => {
  const sent = []
  const rest = { sendMessage: async () => {}, stopSession: async () => ({ success: true }) }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe,
    logger: noopLogger,
    follow: () => true,
  })
  conv.state.sessionId = 's1'
  conv.syncWatcher()
  assert.ok(registered.length > 0, 'the watcher should have subscribed')

  // A turn started from OpenFox: the summary, the compaction done, then the
  // real answer.
  registered[0].onEvent({ type: 'chat.message', payload: { message: { id: 'sum', role: 'assistant', content: 'RÉSUMÉ DE COMPACTION', isCompactionSummary: true } } })
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'sum', reason: 'complete' } })
  registered[0].onEvent({ type: 'chat.delta', payload: { messageId: 'a1', content: 'reponse finale' } })
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'a1', reason: 'complete' } })
  await new Promise((r) => setTimeout(r, 30))

  assert.ok(sent.some((t) => t.includes('reponse finale')), `expected the final answer in follow mode, got: ${JSON.stringify(sent)}`)
  assert.ok(!sent.some((t) => t.includes('RÉSUMÉ DE COMPACTION')), `compaction summary must not be sent in follow mode, got: ${JSON.stringify(sent)}`)
})

test('a compaction with a queued message does not hang the turn', async () => {
  const sent = []
  const rest = { sendMessage: async () => {}, stopSession: async () => ({ success: true }) }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe,
    logger: noopLogger,
  })
  const p = conv.handleText('/send s1 reponds apres compaction avec file')
  assert.ok(await until(() => registered.length > 0), 'the turn should have subscribed')
  const onEvent = registered[0].onEvent

  // A message queued while the turn runs: turn.queued becomes 1.
  await conv.queueText('message en file')
  assert.equal(conv._turn.queued, 1, 'the queued message should be counted')

  // The server emits the compaction summary, then a chat.done for the
  // compaction turn, then the agent continues and emits the real answer.
  onEvent({ type: 'chat.message', payload: { message: { id: 'sum', role: 'assistant', content: 'RÉSUMÉ DE COMPACTION', isCompactionSummary: true } } })
  onEvent({ type: 'chat.done', payload: { messageId: 'sum', reason: 'complete' } })
  // The server then injects the queued message (its own chat.done).
  onEvent({ type: 'chat.done', payload: { messageId: 'asap1', reason: 'complete' } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'a1', content: 'voici la réponse finale.' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'a1', reason: 'complete' } })
  await p

  // The real answer is relayed and the turn ends (no hang).
  assert.ok(
    sent.some((t) => t.includes('voici la réponse finale')),
    `expected the final answer after a compaction with a queued message, got: ${JSON.stringify(sent)}`,
  )
  // The compaction summary must not be relayed to the user.
  assert.ok(
    !sent.some((t) => t.includes('RÉSUMÉ DE COMPACTION')),
    `the compaction summary should not be relayed, got: ${JSON.stringify(sent)}`,
  )
})

test('handleText /stop aborts the running turn and confirms it', async () => {
  const sent = []
  const rest = { sendMessage: async () => {}, stopSession: async () => ({ success: true }) }
  const { subscribe } = fakeSubscribe()
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe,
    logger: noopLogger,
  })
  // Start a turn that will never complete on its own.
  const p = conv.handleText('/send s1 hello')
  await new Promise((r) => setTimeout(r, 5))
  // Stop it.
  await conv.handleText('/stop')
  assert.ok(
    sent.some((t) => t.toLowerCase().includes('arrêté')),
    `expected a "stopped" confirmation, got: ${JSON.stringify(sent)}`,
  )
  // The aborted turn must resolve (not hang forever).
  await p
})

test('handleText /stop with no running turn says there is nothing to stop', async () => {
  const sent = []
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest: { sendMessage: async () => {} },
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/stop')
  assert.ok(sent.some((t) => t.toLowerCase().includes('rien à arrêter')), `got: ${JSON.stringify(sent)}`)
})

// ---------------------------------------------------------------------------
// Conversation — state machine
// ---------------------------------------------------------------------------

test('handleText /start lists projects and sets stage to pick_project', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t, extra) => sent.push({ t, extra }), sendChatAction: async () => {} }
  const rest = { listProjects: async () => [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })

  await conv.handleText('/start')
  assert.equal(conv.state.stage, 'pick_project')
  const projMsg = sent[sent.length - 1]
  assert.ok(projMsg.extra?.reply_markup?.inline_keyboard, 'expected inline keyboard for projects')
  const buttons = projMsg.extra.reply_markup.inline_keyboard
  assert.ok(buttons.some((row) => row[0].callback_data === 'proj:p1'), 'expected button for p1')
  assert.ok(buttons.some((row) => row[0].callback_data === 'proj:p2'), 'expected button for p2')
})

test('handleText number selects a project then lists sessions', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t, extra) => sent.push({ t, extra }), sendChatAction: async () => {} }
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }],
    listSessions: async (pid) => {
      assert.equal(pid, 'p1')
      return [{ id: 's1', title: 'S1' }]
    },
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  await conv.handleText('/start')
  await conv.handleText('1')
  assert.equal(conv.state.projectId, 'p1')
  assert.equal(conv.state.stage, 'pick_session')
  const last = sent[sent.length - 1]
  assert.ok(last.extra?.reply_markup, 'expected inline keyboard for sessions')
  assert.ok(last.extra.reply_markup.inline_keyboard.some((row) => row[0].callback_data === 'sess:s1'), 'expected button for s1')
})

test('handleText number selects a session and activates it', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [{ id: 's1', title: 'S1' }, { id: 's2', title: 'S2' }],
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  await conv.handleText('/start')
  await conv.handleText('1')
  await conv.handleText('2')
  assert.equal(conv.state.sessionId, 's2')
  assert.equal(conv.state.stage, 'active')
})

test('handleText /sessions (no arg) lists the sessions of the current project', async () => {
  const sent = []
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async (pid) => {
      assert.equal(pid, 'p1')
      return [{ id: 's1', title: 'S1' }]
    },
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => sent.push({ t, extra }), sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  await conv.handleText('1') // select project p1
  await conv.handleText('/sessions')
  const last = sent[sent.length - 1]
  assert.ok(last.extra?.reply_markup, `expected inline keyboard, got: ${JSON.stringify(last.extra)}`)
  assert.ok(last.extra.reply_markup.inline_keyboard.some((row) => row[0].callback_data === 'sess:s1'), `expected button for s1`)
})

test('handleText /agents lists the available agents', async () => {
  const sent = []
  const rest = {
    listAgents: async () => [
      { id: 'builder', name: 'Builder', description: 'Implements the task' },
      { id: 'planner', name: 'Planner', description: 'Defines criteria' },
    ],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => sent.push({ t, extra }), sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/agents')
  const last = sent[sent.length - 1]
  assert.ok(last.extra?.reply_markup, `expected inline keyboard`)
  const buttons = last.extra.reply_markup.inline_keyboard
  assert.equal(buttons.length, 2, `expected 2 agent buttons`)
  assert.equal(buttons[0][0].text, 'Builder')
  assert.equal(buttons[1][0].text, 'Planner')
})

test('handleText /agent with no active session says to pick one first', async () => {
  const sent = []
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest: { listAgents: async () => [] },
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/agent builder')
  assert.ok(sent.join('\n').toLowerCase().includes('session'), `got: ${JSON.stringify(sent)}`)
})

test('handleText plain text forwards to the active session', async () => {
  const restCalls = []
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [{ id: 's1', title: 'S1' }],
    sendMessage: async (sessionId, content) => {
      restCalls.push([sessionId, content])
    },
  }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })
  await conv.handleText('/start')
  await conv.handleText('1')
  await conv.handleText('1')
  // Now active on s1. Plain text is forwarded.
  const p = conv.handleText('do the thing')
  // Wait a tick for the subscribe to be registered (locale fetch adds a microtask).
  await new Promise((r) => setTimeout(r, 5))
  // The turn completes when the server emits chat.done.
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p
  assert.deepEqual(restCalls, [['s1', 'do the thing']])
})

test('handleText /new creates a project directly', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = {
    createProject: async (name, workdir) => ({ id: 'p9', name, workdir }),
    getDefaultWorkdir: async () => '/srv/workspace',
    listSessions: async () => [{ id: 's1', title: 'S1' }],
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  await conv.handleText('/new Demo')
  assert.equal(conv.state.projectId, 'p9')
  assert.equal(conv.state.stage, 'pick_session')
})

test('handleText /new-session creates a session in the current project', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [{ id: 's1', title: 'S1' }],
    createSession: async (pid, title) => {
      assert.equal(pid, 'p1')
      return { id: 's5', title }
    },
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  await conv.handleText('/start')
  await conv.handleText('1')
  await conv.handleText('/new-session Hello')
  assert.equal(conv.state.sessionId, 's5')
  assert.equal(conv.state.stage, 'active')
})

test('register uses OPENFOX_PORT env var for base URL', () => {
  const origPort = process.env.OPENFOX_PORT
  process.env.OPENFOX_PORT = '10370'
  const settingsCalls = []
  const registry = {
    context: {
      settings: () => ({}),
      logger: noopLogger,
      storage: { get: () => undefined, set() {} },
    },
    registerSettings: (schema) => settingsCalls.push(schema),
  }
  register(registry)
  const keys = settingsCalls[0].fields.map((f) => f.key)
  assert.ok(!keys.includes('baseUrl'), 'baseUrl should not be a setting')
  if (origPort !== undefined) process.env.OPENFOX_PORT = origPort
  else delete process.env.OPENFOX_PORT
})

test('register registers settings and does not start without a bot token', () => {
  const settingsCalls = []
  const registry = {
    context: {
      settings: () => ({}),
      logger: noopLogger,
      storage: { get: () => undefined, set() {} },
    },
    registerSettings: (schema) => settingsCalls.push(schema),
  }
  // Must not throw even when no bot token is configured.
  register(registry)
  assert.equal(settingsCalls.length, 1)
  const keys = settingsCalls[0].fields.map((f) => f.key)
  assert.ok(keys.includes('botToken'))
  assert.ok(!keys.includes('baseUrl'))
  const tokenField = settingsCalls[0].fields.find((f) => f.key === 'botToken')
  assert.equal(tokenField.secret, true)
})

// ---------------------------------------------------------------------------
// Conversation — inline keyboard (callback_query)
// ---------------------------------------------------------------------------

test('handleText /agents sends an inline keyboard with one button per agent', async () => {
  const sent = []
  const rest = {
    listAgents: async () => [
      { id: 'builder', name: 'Builder', description: 'Implements the task' },
      { id: 'planner', name: 'Planner', description: 'Defines criteria' },
    ],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: {
      sendMessage: async (c, t, extra) => { sent.push({ t, extra }) },
      sendChatAction: async () => {},
    },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/agents')
  // The last message should carry a reply_markup with inline_keyboard.
  const last = sent[sent.length - 1]
  assert.ok(last.extra?.reply_markup, `expected reply_markup, got: ${JSON.stringify(last.extra)}`)
  const buttons = last.extra.reply_markup.inline_keyboard
  assert.equal(buttons.length, 2)
  // Each row has one button with callback_data = 'agent:<id>'.
  assert.equal(buttons[0][0].callback_data, 'agent:builder')
  assert.equal(buttons[1][0].callback_data, 'agent:planner')
})

test('handleCallback sets the agent when a button is tapped', async () => {
  const sent = []
  const modeCalls = []
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [{ id: 's1', title: 'S1' }],
    setSessionMode: async (sessionId, mode) => {
      modeCalls.push([sessionId, mode])
      return { id: sessionId, mode }
    },
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  await conv.handleText('1') // select project p1
  await conv.handleText('1') // select session s1 (active)
  // Simulate a button tap.
  await conv.handleCallback('agent:builder')
  assert.deepEqual(modeCalls, [['s1', 'builder']])
  assert.ok(sent.join('\n').toLowerCase().includes('builder'), `got: ${JSON.stringify(sent)}`)
})

test('handleCallback with no active session says to pick one first', async () => {
  const sent = []
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest: { listAgents: async () => [] },
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleCallback('agent:builder')
  assert.ok(sent.join('\n').toLowerCase().includes('session'), `got: ${JSON.stringify(sent)}`)
})

test('handleCallback with unknown data is ignored (no crash)', async () => {
  const sent = []
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest: { listAgents: async () => [] },
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  // Unknown callback data must not throw and must not send anything.
  await conv.handleCallback('unknown:stuff')
  assert.equal(sent.length, 0)
})

test('OpenFoxRestClient.getLocale returns fr for French locale', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ key: 'display.locale', value: 'fr' }) }
    },
  })
  const locale = await client.getLocale()
  assert.equal(locale, 'fr')
  assert.ok(calls[0][0].includes('/api/settings/display.locale'))
})

test('OpenFoxRestClient.getLocale returns fr for French or automatic locale', async () => {
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async () => ({ status: 200, json: async () => ({ key: 'display.locale', value: 'automatic' }) }),
  })
  assert.equal(await client.getLocale(), 'fr')
  const client2 = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async () => ({ status: 200, json: async () => ({ key: 'display.locale', value: 'en' }) }),
  })
  assert.equal(await client2.getLocale(), 'en')
})

test('Conversation uses English messages when locale is en', async () => {
  const sent = []
  const rest = {
    getLocale: async () => 'en',
    listProjects: async () => [],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/stop')
  const texts = sent.map((s) => (typeof s === 'string' ? s : s.t))
  assert.ok(texts.some((t) => t.includes('Nothing to stop')), `expected English message, got: ${JSON.stringify(texts)}`)
})

test('Conversation uses French messages when locale is fr', async () => {
  const sent = []
  const rest = {
    getLocale: async () => 'fr',
    listProjects: async () => [],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/stop')
  const texts = sent.map((s) => (typeof s === 'string' ? s : s.t))
  assert.ok(texts.some((t) => t.includes('Rien à arrêter')), `expected French message, got: ${JSON.stringify(texts)}`)
})

test('Conversation falls back to fr when getLocale fails', async () => {
  const sent = []
  const rest = {
    getLocale: async () => { throw new Error('network error') },
    listProjects: async () => [],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/stop')
  const texts = sent.map((s) => (typeof s === 'string' ? s : s.t))
  assert.ok(texts.some((t) => t.includes('Rien à arrêter')), `expected French fallback, got: ${JSON.stringify(texts)}`)
})

// ---------------------------------------------------------------------------
// Runtime — callback_query dispatch
// ---------------------------------------------------------------------------

test('runtime: callback_query from authorized user is answered and routed to conversation', async () => {
  const telegram = fakeTelegram()
  const rest = {
    async getHealth() { return { status: 'ok' } },
    async listSessions() { return [] },
    async createSession() { throw new Error('no') },
    async sendToSession() { throw new Error('no') },
    async listSubscriptions() { return [] },
    async listAgents() { return [] },
    async setSessionMode() { throw new Error('no') },
  }
  const r = createRuntime({ telegram, rest, subscribe: () => ({ close() {} }), logger: noopLogger, auth: { userId: 42 } })
  r.start()
  // Seed a conversation via a message first
  await telegram._push({
    update_id: 1,
    message: { chat: { id: 101, type: 'private' }, text: '/ping', from: { id: 42 }, date: 1 },
  })
  await sleep(10)
  // Now push a callback_query
  await telegram._push({
    update_id: 2,
    callback_query: {
      id: 'cb1',
      from: { id: 42 },
      message: { chat: { id: 101, type: 'private' } },
      data: 'agent:builder',
    },
  })
  // Wait longer than the 50ms poll cycle so the callback is processed.
  await sleep(100)
  r.stop()
  // The fake telegram records answerCallbackQuery calls
  assert.ok(telegram.answered.includes('cb1'), `expected cb1 to be answered, got: ${JSON.stringify(telegram.answered)}`)
})

// ---------------------------------------------------------------------------
// Conversation — interactive buttons on all commands
// ---------------------------------------------------------------------------

test('BOT_COMMANDS no longer includes agent', () => {
  const cmds = BOT_COMMANDS.map((c) => c.command)
  assert.ok(!cmds.includes('agent'), 'agent should be removed from BOT_COMMANDS')
})

test('handleText /start lists the projects without a trailing "Menu" message', async () => {
  const sent = []
  const rest = { listProjects: async () => [{ id: 'p1', name: 'A' }] }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  assert.ok(!sent.some((m) => /^Menu/.test(m.t)), `no "Menu" message, got: ${JSON.stringify(sent.map((m) => m.t))}`)
  assert.ok(sent.at(-1).extra?.reply_markup?.inline_keyboard, 'the last message is the project list')
})

test('BOT_COMMANDS does not include help', () => {
  const cmds = BOT_COMMANDS.map((c) => c.command)
  assert.ok(!cmds.includes('help'), 'help should be removed from BOT_COMMANDS')
})

test('handleText /start sends inline keyboard with one button per project + new', async () => {
  const sent = []
  const rest = { listProjects: async () => [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  const projMsg = sent[sent.length - 1]
  assert.ok(projMsg.extra?.reply_markup, `expected reply_markup, got: ${JSON.stringify(projMsg.extra)}`)
  const buttons = projMsg.extra.reply_markup.inline_keyboard
  // 2 project buttons + 1 new = 3 rows
  assert.equal(buttons.length, 3, `expected 3 button rows, got ${buttons.length}`)
  assert.equal(buttons[0][0].callback_data, 'proj:p1')
  assert.equal(buttons[1][0].callback_data, 'proj:p2')
})

test('handleText /start with no projects sends keyboard with new', async () => {
  const sent = []
  const rest = { listProjects: async () => [] }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  const projMsg = sent[sent.length - 1]
  assert.ok(projMsg.extra?.reply_markup, `expected reply_markup, got: ${JSON.stringify(projMsg.extra)}`)
  const buttons = projMsg.extra.reply_markup.inline_keyboard
  assert.equal(buttons.length, 1, `expected 1 button row, got ${buttons.length}`)
})

test('handleText /sessions sends inline keyboard with one button per session + new', async () => {
  const sent = []
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [{ id: 's1', title: 'S1' }, { id: 's2', title: 'S2' }],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  await conv.handleText('1') // select project
  await conv.handleText('/sessions')
  const last = sent[sent.length - 1]
  assert.ok(last.extra?.reply_markup, `expected reply_markup, got: ${JSON.stringify(last.extra)}`)
  const buttons = last.extra.reply_markup.inline_keyboard
  // 2 session buttons + 1 new + 1 back = 4 rows
  assert.equal(buttons.length, 4, `expected 4 button rows, got ${buttons.length}`)
  assert.equal(buttons[0][0].callback_data, 'sess:s1')
  assert.equal(buttons[1][0].callback_data, 'sess:s2')
})

test('handleText /sessions with no sessions sends keyboard with new + back', async () => {
  const sent = []
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  await conv.handleText('1') // select project
  await conv.handleText('/sessions')
  const last = sent[sent.length - 1]
  assert.ok(last.extra?.reply_markup, `expected reply_markup, got: ${JSON.stringify(last.extra)}`)
  const buttons = last.extra.reply_markup.inline_keyboard
  assert.equal(buttons.length, 2, `expected 2 button rows, got ${buttons.length}`)
})

test('handleCallback proj:<id> selects project and shows sessions with buttons', async () => {
  const sent = []
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }],
    listSessions: async (pid) => {
      assert.equal(pid, 'p1')
      return [{ id: 's1', title: 'S1' }]
    },
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  await conv.handleCallback('proj:p1')
  assert.equal(conv.state.projectId, 'p1')
  assert.equal(conv.state.stage, 'pick_session')
  const last = sent[sent.length - 1]
  assert.ok(last.extra?.reply_markup, `expected reply_markup after project selection`)
})

test('handleCallback sess:<id> selects session and activates it', async () => {
  const sent = []
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [{ id: 's1', title: 'S1' }, { id: 's2', title: 'S2' }],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  await conv.handleText('1') // select project
  await conv.handleCallback('sess:s2')
  assert.equal(conv.state.sessionId, 's2')
  assert.equal(conv.state.stage, 'active')
  assert.ok(sent.length > 0, 'should confirm the active session')
})

test('handleCallback sess:<id> shows the session title in the confirmation message', async () => {
  const sent = []
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [{ id: 's1', title: 'Ma session' }, { id: 's2', title: 'Autre session' }],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  await conv.handleText('1') // select project (populates _cachedSessions)
  await conv.handleCallback('sess:s2')
  const texts = sent.map((s) => (typeof s === 'string' ? s : s.t))
  const lastText = texts[texts.length - 1]
  assert.ok(lastText.includes('Autre session'), `expected session title in confirmation, got: ${lastText}`)
  assert.ok(!lastText.includes('sess:s2'), `should not show the raw callback data, got: ${lastText}`)
})

test('handleCallback new_proj prompts for project name', async () => {
  const sent = []
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest: { listProjects: async () => [] },
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleCallback('new_proj')
  assert.equal(conv.state.stage, 'new_project_name')
  assert.ok(sent.length > 0, 'should send a prompt message')
})

test('handleCallback new_sess prompts for session title when project is set', async () => {
  const sent = []
  const rest = {
    listProjects: async () => [{ id: 'p1', name: 'A' }],
    listSessions: async () => [{ id: 's1', title: 'S1' }],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/start')
  await conv.handleText('1') // select project
  await conv.handleCallback('new_sess')
  assert.equal(conv.state.stage, 'new_session_title')
  assert.ok(sent.length > 0, 'should send a prompt message')
})

test('handleCallback new_sess without project says to pick one first', async () => {
  const sent = []
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest: { listProjects: async () => [] },
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleCallback('new_sess')
  const texts = sent.map((s) => s.t ?? '')
  assert.ok(texts.some((t) => t.toLowerCase().includes('projet')), `expected a "pick a project" message, got: ${JSON.stringify(texts)}`)
})

test('handleCallback reset shows projects with buttons', async () => {
  const sent = []
  const rest = { listProjects: async () => [{ id: 'p1', name: 'A' }] }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleCallback('reset')
  assert.equal(conv.state.stage, 'pick_project')
  const last = sent[sent.length - 1]
  assert.ok(last.extra?.reply_markup, `expected reply_markup after reset`)
})


test('handleText /agent is no longer a recognized command', async () => {
  const sent = []
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest: { listAgents: async () => [] },
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  // /agent should be treated as plain text, not show usage
  await conv.handleText('/agent')
  const texts = sent.map((s) => (typeof s === 'string' ? s : s.t))
  assert.ok(!texts.some((t) => t.toLowerCase().includes('usage: /agent')), `/agent should not show usage, got: ${JSON.stringify(texts)}`)
})

test('handleText in new_project_name stage accepts a name as continuation', async () => {
  const sent = []
  const created = []
  const rest = {
    createProject: async (name, workdir) => {
      created.push([name, workdir])
      return { id: 'p9', name, workdir }
    },
    getDefaultWorkdir: async () => '/srv/workspace',
    listSessions: async () => [{ id: 's1', title: 'S1' }],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t, extra) => { sent.push({ t, extra }) }, sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleCallback('new_proj')
  assert.equal(conv.state.stage, 'new_project_name')
  // Send the project name — project is created directly with default workdir
  await conv.handleText('MyProject')
  assert.deepEqual(created, [['MyProject', '/srv/workspace/MyProject']])
  assert.equal(conv.state.projectId, 'p9')
})

test('runtime: callback_query from unauthorized user is ignored', async () => {
  const telegram = fakeTelegram()
  const rest = {
    async getHealth() { return { status: 'ok' } },
    async listSessions() { return [] },
    async createSession() { throw new Error('no') },
    async sendToSession() { throw new Error('no') },
    async listSubscriptions() { return [] },
    async listAgents() { return [] },
    async setSessionMode() { throw new Error('no') },
  }
  const r = createRuntime({ telegram, rest, subscribe: () => ({ close() {} }), logger: noopLogger, auth: { userId: 42 } })
  r.start()
  await telegram._push({
    update_id: 1,
    callback_query: {
      id: 'cb2',
      from: { id: 99 },
      message: { chat: { id: 101, type: 'private' } },
      data: 'agent:builder',
    },
  })
  // Wait longer than the 50ms poll cycle so the (ignored) callback is processed.
  await sleep(100)
  r.stop()
  assert.ok(!telegram.answered.includes('cb2'), `expected cb2 to NOT be answered, got: ${JSON.stringify(telegram.answered)}`)
})

test('Conversation: historyCount setting controls number of history messages', async () => {
  const messages = [
    { role: 'user', content: 'msg1' },
    { role: 'assistant', content: 'msg2' },
    { role: 'user', content: 'msg3' },
    { role: 'assistant', content: 'msg4' },
    { role: 'user', content: 'msg5' },
    { role: 'assistant', content: 'msg6' },
  ]
  const rest = {
    async getHealth() { return { status: 'ok' } },
    async listProjects() { return [{ id: 'p1', name: 'Proj' }] },
    async listSessions() { return [{ id: 's1', title: 'Sess' }] },
    async createSession() { throw new Error('no') },
    async sendMessage() { throw new Error('no') },
    async listAgents() { return [] },
    async getLocale() { return 'fr' },
    async getDefaultWorkdir() { return '/tmp' },
    async setSessionMode() { throw new Error('no') },
    async getSessionDetail() { return { messages } },
  }
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: () => ({ close() {} }), historyCount: 4 })
  conv.state.projectId = 'p1'
  conv.state.stage = 'pick_session'
  conv._cachedSessions = [{ id: 's1', title: 'Sess' }]
  await conv.select('1')
  const sent = telegram.sent
  const lastMsg = sent[sent.length - 1]
  assert.ok(lastMsg.text.includes('msg3'), `should contain msg3`)
  assert.ok(lastMsg.text.includes('msg4'), `should contain msg4`)
  assert.ok(lastMsg.text.includes('msg5'), `should contain msg5`)
  assert.ok(lastMsg.text.includes('msg6'), `should contain msg6`)
  assert.ok(!lastMsg.text.includes('msg1'), `should NOT contain msg1 (only last 4)`)
  assert.ok(!lastMsg.text.includes('msg2'), `should NOT contain msg2 (only last 4)`)
})

test('Conversation: default historyCount is 6', async () => {
  const messages = [
    { role: 'user', content: 'm1' },
    { role: 'assistant', content: 'm2' },
    { role: 'user', content: 'm3' },
    { role: 'assistant', content: 'm4' },
    { role: 'user', content: 'm5' },
    { role: 'assistant', content: 'm6' },
    { role: 'user', content: 'm7' },
  ]
  const rest = {
    async getHealth() { return { status: 'ok' } },
    async listProjects() { return [{ id: 'p1', name: 'Proj' }] },
    async listSessions() { return [{ id: 's1', title: 'Sess' }] },
    async createSession() { throw new Error('no') },
    async sendMessage() { throw new Error('no') },
    async listAgents() { return [] },
    async getLocale() { return 'fr' },
    async getDefaultWorkdir() { return '/tmp' },
    async setSessionMode() { throw new Error('no') },
    async getSessionDetail() { return { messages } },
  }
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: () => ({ close() {} }) })
  conv.state.projectId = 'p1'
  conv.state.stage = 'pick_session'
  conv._cachedSessions = [{ id: 's1', title: 'Sess' }]
  await conv.select('1')
  const sent = telegram.sent
  const lastMsg = sent[sent.length - 1]
  assert.ok(lastMsg.text.includes('m7'), `should contain m7`)
  assert.ok(lastMsg.text.includes('m2'), `should contain m2 (6th from last)`)
  assert.ok(!lastMsg.text.includes('m1'), `should NOT contain m1 (only last 6)`)
})

test('Conversation: selecting a session shows last 6 messages with roles', async () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: 'how are you' },
    { role: 'assistant', content: "I'm good, thanks." },
    { role: 'user', content: 'tell me a joke' },
    { role: 'assistant', content: 'Why did the chicken cross the road?' },
    { role: 'user', content: 'another joke' },
    { role: 'assistant', content: 'What do you call a frog that sings? A hip-hop frog!' },
  ]
  const rest = {
    async getHealth() { return { status: 'ok' } },
    async listProjects() { return [{ id: 'p1', name: 'Proj' }] },
    async listSessions() { return [{ id: 's1', title: 'Sess' }] },
    async createSession() { throw new Error('no') },
    async sendMessage() { throw new Error('no') },
    async listAgents() { return [] },
    async getLocale() { return 'fr' },
    async getDefaultWorkdir() { return '/tmp' },
    async setSessionMode() { throw new Error('no') },
    async getSessionDetail() { return { messages } },
  }
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: () => ({ close() {} }) })
  conv.state.projectId = 'p1'
  conv.state.stage = 'pick_session'
  conv._cachedSessions = [{ id: 's1', title: 'Sess' }]
  await conv.select('1')
  const sent = telegram.sent
  const lastMsg = sent[sent.length - 1]
  assert.ok(lastMsg.text.includes('👤 Vous : how are you'), 'should contain user msg with prefix')
  assert.ok(lastMsg.text.includes("🤖 Agent : I'm good, thanks."), 'should contain agent msg with prefix')
  assert.ok(lastMsg.text.includes('👤 Vous : tell me a joke'), 'should contain 2nd user msg')
  assert.ok(lastMsg.text.includes('🤖 Agent : Why did the chicken cross the road?'), 'should contain 2nd agent msg')
  assert.ok(lastMsg.text.includes('👤 Vous : another joke'), 'should contain 3rd user msg')
  assert.ok(lastMsg.text.includes('🤖 Agent : What do you call a frog'), 'should contain 3rd agent msg')
  assert.ok(!lastMsg.text.includes('👤 Vous : hello'), 'should NOT contain first user msg (only last 6)')
  assert.ok(!lastMsg.text.includes('🤖 Agent : Hi there!'), 'should NOT contain first agent msg (only last 6)')
})

test('runTurn strips <system-reminder> tags from agent response', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'hello')
  const { onEvent } = registered[0]
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Bonjour' } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: ' <system-reminder>you are in Builder mode</system-reminder>' } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: ' au revoir' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  const text = sent[0]
  assert.ok(!text.includes('<system-reminder>'), `should not contain system-reminder, got: ${text}`)
  assert.ok(text.includes('Bonjour'), `should contain the visible text, got: ${text}`)
  assert.ok(text.includes('au revoir'), `should contain the rest, got: ${text}`)
})

test('runTurn strips multiple <system-reminder> blocks', async () => {
  const sent = []
  const telegram = { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'x')
  const { onEvent } = registered[0]
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Partie 1 <system-reminder>aaa</system-reminder> partie 2 <system-reminder>bbb</system-reminder> fin' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  const text = sent[0]
  assert.ok(!text.includes('aaa'), `should not contain first reminder content`)
  assert.ok(!text.includes('bbb'), `should not contain second reminder content`)
  assert.ok(text.includes('Partie 1'), `should contain text before first reminder`)
  assert.ok(text.includes('partie 2'), `should contain text between reminders`)
  assert.ok(text.includes('fin'), `should contain text after last reminder`)
})

test('showSessionActive strips <system-reminder> from history messages', async () => {
  const messages = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'Hi <system-reminder>secret</system-reminder>!' },
  ]
  const rest = {
    async getHealth() { return { status: 'ok' } },
    async listProjects() { return [{ id: 'p1', name: 'Proj' }] },
    async listSessions() { return [{ id: 's1', title: 'Sess' }] },
    async createSession() { throw new Error('no') },
    async sendMessage() { throw new Error('no') },
    async listAgents() { return [] },
    async getLocale() { return 'fr' },
    async getDefaultWorkdir() { return '/tmp' },
    async setSessionMode() { throw new Error('no') },
    async getSessionDetail() { return { messages } },
  }
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: () => ({ close() {} }) })
  conv.state.projectId = 'p1'
  conv.state.stage = 'pick_session'
  conv._cachedSessions = [{ id: 's1', title: 'Sess' }]
  await conv.select('1')
  const sent = telegram.sent
  const lastMsg = sent[sent.length - 1]
  assert.ok(!lastMsg.text.includes('<system-reminder>'), `should not contain system-reminder tag`)
  assert.ok(!lastMsg.text.includes('secret'), `should not contain reminder content`)
  assert.ok(lastMsg.text.includes('🤖 Agent : Hi'), `should contain cleaned agent message`)
})

test('Conversation: selecting a session with only user messages shows them with prefix', async () => {
  const rest = {
    async getHealth() { return { status: 'ok' } },
    async listProjects() { return [{ id: 'p1', name: 'Proj' }] },
    async listSessions() { return [{ id: 's1', title: 'Sess' }] },
    async createSession() { throw new Error('no') },
    async sendMessage() { throw new Error('no') },
    async listAgents() { return [] },
    async getLocale() { return 'fr' },
    async getDefaultWorkdir() { return '/tmp' },
    async setSessionMode() { throw new Error('no') },
    async getSessionDetail() { return { messages: [{ role: 'user', content: 'hello' }] } },
  }
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: () => ({ close() {} }) })
  conv.state.projectId = 'p1'
  conv.state.stage = 'pick_session'
  conv._cachedSessions = [{ id: 's1', title: 'Sess' }]
  await conv.select('1')
  const sent = telegram.sent
  const lastMsg = sent[sent.length - 1]
  assert.ok(lastMsg.text.includes('Sess'), 'should contain session title')
  assert.ok(lastMsg.text.includes('👤 Vous : hello'), 'should contain user message with prefix')
})

// ---------------------------------------------------------------------------
// Tool call forwarding
// ---------------------------------------------------------------------------

test('runTurn forwards tool calls with ✓ on success', async () => {
  const sent = []
  const telegram = {
    sendMessage: async (chatId, text) => { sent.push(text) },
    sendChatAction: async () => {},
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'hello')
  const { onEvent } = registered[0]

  onEvent({ type: 'chat.tool_call', payload: { messageId: 'm1', callId: 'tc1', tool: 'run_command', args: { command: 'ls -la' } } })
  onEvent({ type: 'chat.tool_result', payload: { messageId: 'm1', callId: 'tc1', tool: 'run_command', result: { success: true, output: 'total 0', durationMs: 120, truncated: false } } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Done' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  const toolMsg = sent.filter((t) => t.includes('run_command')).at(-1)
  assert.ok(toolMsg, 'should have a tool call message')
  assert.ok(toolMsg.includes('✓'), 'should have success icon')
  assert.ok(toolMsg.includes('ls -la'), 'should show the command')
})

test('runTurn forwards tool calls with ✗ on failure', async () => {
  const sent = []
  const telegram = {
    sendMessage: async (chatId, text) => { sent.push(text) },
    sendChatAction: async () => {},
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'hello')
  const { onEvent } = registered[0]

  onEvent({ type: 'chat.tool_call', payload: { messageId: 'm1', callId: 'tc1', tool: 'run_command', args: { command: 'npm test' } } })
  onEvent({ type: 'chat.tool_result', payload: { messageId: 'm1', callId: 'tc1', tool: 'run_command', result: { success: false, error: 'exit code 1', durationMs: 5000, truncated: false } } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Failed' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  const toolMsg = sent.filter((t) => t.includes('run_command')).at(-1)
  assert.ok(toolMsg, 'should have a tool call message')
  assert.ok(toolMsg.includes('✗'), 'should have failure icon')
  assert.ok(toolMsg.includes('npm test'), 'should show the command')
})

test('runTurn formats read_file tool calls with path', async () => {
  const sent = []
  const telegram = {
    sendMessage: async (chatId, text) => { sent.push(text) },
    sendChatAction: async () => {},
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'hello')
  const { onEvent } = registered[0]

  onEvent({ type: 'chat.tool_call', payload: { messageId: 'm1', callId: 'tc1', tool: 'read_file', args: { path: 'src/index.js' } } })
  onEvent({ type: 'chat.tool_result', payload: { messageId: 'm1', callId: 'tc1', tool: 'read_file', result: { success: true, durationMs: 50, truncated: false } } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'ok' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  const toolMsg = sent.filter((t) => t.includes('read_file')).at(-1)
  assert.ok(toolMsg, 'should have a tool call message')
  assert.ok(toolMsg.includes('✓'), 'should have success icon')
  assert.ok(toolMsg.includes('src/index.js'), 'should show the path')
})

test('runTurn does not forward unknown tool results (no matching call)', async () => {
  const sent = []
  const telegram = {
    sendMessage: async (chatId, text) => { sent.push(text) },
    sendChatAction: async () => {},
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'hello')
  const { onEvent } = registered[0]

  // Result without a preceding tool_call should be ignored
  onEvent({ type: 'chat.tool_result', payload: { messageId: 'm1', callId: 'orphan', tool: 'run_command', result: { success: true, durationMs: 10, truncated: false } } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'ok' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  assert.equal(sent.length, 1, 'only the final text should be sent')
  assert.equal(sent[0], 'ok')
})

// ---------------------------------------------------------------------------
// Path confirmation
// ---------------------------------------------------------------------------

test('runTurn sends path confirmation with buttons', async () => {
  const sent = []
  const telegram = {
    sendMessage: async (chatId, text, opts) => { sent.push({ text, opts }) },
    sendChatAction: async () => {},
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })

  const p = conv.runTurn('s1', 'hello')
  const { onEvent } = registered[0]

  onEvent({ type: 'chat.path_confirmation', payload: { messageId: 'm1', callId: 'pc:1:2', tool: 'run_command', paths: ['/nonexistent-file'], reason: 'outside_workdir', workdir: '/project' } })
  onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'ok' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await p

  const confirmMsg = sent.find((m) => m.text.includes('🔒'))
  assert.ok(confirmMsg, 'should have a path confirmation message')
  assert.ok(confirmMsg.text.includes('run_command'), 'should show the tool name')
  assert.ok(confirmMsg.text.includes('/nonexistent-file'), 'should show the path')
  assert.ok(confirmMsg.opts?.reply_markup, 'should have a keyboard')
  const rows = confirmMsg.opts.reply_markup.inline_keyboard
  assert.equal(rows.length, 2, 'should have 2 rows of buttons')
  assert.equal(rows[0][0].text, 'Autoriser')
  assert.equal(rows[0][0].callback_data, 'path_confirm:pc:1:2:allow')
  assert.equal(rows[0][1].text, 'Refuser')
  assert.equal(rows[0][1].callback_data, 'path_confirm:pc:1:2:deny')
  assert.equal(rows[1][0].text, 'Tout autoriser')
  assert.equal(rows[1][0].callback_data, 'path_confirm:pc:1:2:always')
})

test('handleCallback path_confirm:allow calls confirmPath with approved=true', async () => {
  const confirmCalls = []
  const telegram = {
    sendMessage: async (chatId, text) => {},
    sendChatAction: async () => {},
    editMessageReplyMarkup: async () => {},
  }
  const rest = {
    sendMessage: async () => {},
    confirmPath: async (sessionId, callId, approved, alwaysAllow) => {
      confirmCalls.push({ sessionId, callId, approved, alwaysAllow })
    },
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  conv.state.sessionId = 's1'
  conv.state.pendingPathConfirms = new Map([['abc:def', { sessionId: 's1', messageId: 'pc1' }]])

  await conv.handleCallback('path_confirm:abc:def:allow')

  assert.equal(confirmCalls.length, 1)
  assert.equal(confirmCalls[0].sessionId, 's1')
  assert.equal(confirmCalls[0].callId, 'abc:def')
  assert.equal(confirmCalls[0].approved, true)
  assert.equal(confirmCalls[0].alwaysAllow, false)
})

test('handleCallback path_confirm:deny calls confirmPath with approved=false', async () => {
  const confirmCalls = []
  const telegram = {
    sendMessage: async (chatId, text) => {},
    sendChatAction: async () => {},
    editMessageReplyMarkup: async () => {},
  }
  const rest = {
    sendMessage: async () => {},
    confirmPath: async (sessionId, callId, approved, alwaysAllow) => {
      confirmCalls.push({ sessionId, callId, approved, alwaysAllow })
    },
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  conv.state.sessionId = 's1'
  conv.state.pendingPathConfirms = new Map([['abc:def', { sessionId: 's1', messageId: 'pc1' }]])

  await conv.handleCallback('path_confirm:abc:def:deny')

  assert.equal(confirmCalls.length, 1)
  assert.equal(confirmCalls[0].approved, false)
})

test('handleCallback path_confirm:always switches the session to dangerous mode (no confirmPath needed)', async () => {
  const calls = []
  const telegram = {
    sendMessage: async () => {},
    sendChatAction: async () => {},
    editMessageReplyMarkup: async () => {},
  }
  const rest = {
    sendMessage: async () => {},
    confirmPath: async (...a) => { calls.push(['confirmPath', ...a]) },
    setDangerLevel: async (...a) => { calls.push(['setDangerLevel', ...a]) },
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  conv.state.sessionId = 's1'
  conv.state.pendingPathConfirms = new Map([['abc:def', { sessionId: 's1', messageId: 'pc1' }]])

  await conv.handleCallback('path_confirm:abc:def:always')

  assert.deepEqual(calls, [['setDangerLevel', 's1', 'dangerous']])
})

test('handleCallback path_confirm:always also sets danger level to dangerous', async () => {
  const confirmCalls = []
  const dangerCalls = []
  const telegram = {
    sendMessage: async (chatId, text) => {},
    sendChatAction: async () => {},
    editMessageReplyMarkup: async () => {},
  }
  const rest = {
    sendMessage: async () => {},
    confirmPath: async (sessionId, callId, approved, alwaysAllow) => {
      confirmCalls.push({ sessionId, callId, approved, alwaysAllow })
    },
    setDangerLevel: async (sessionId, dangerLevel) => {
      dangerCalls.push({ sessionId, dangerLevel })
    },
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  conv.state.sessionId = 's1'
  conv.state.pendingPathConfirms = new Map([['abc:def', { sessionId: 's1', messageId: 'pc1' }]])

  await conv.handleCallback('path_confirm:abc:def:always')

  assert.equal(dangerCalls.length, 1)
  assert.equal(dangerCalls[0].sessionId, 's1')
  assert.equal(dangerCalls[0].dangerLevel, 'dangerous')
})

test('handleCallback path_confirm:allow does NOT set danger level', async () => {
  const dangerCalls = []
  const telegram = {
    sendMessage: async (chatId, text) => {},
    sendChatAction: async () => {},
    editMessageReplyMarkup: async () => {},
  }
  const rest = {
    sendMessage: async () => {},
    confirmPath: async () => {},
    setDangerLevel: async (sessionId, dangerLevel) => {
      dangerCalls.push({ sessionId, dangerLevel })
    },
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  conv.state.sessionId = 's1'
  conv.state.pendingPathConfirms = new Map([['abc:def', { sessionId: 's1', messageId: 'pc1' }]])

  await conv.handleCallback('path_confirm:abc:def:allow')

  assert.equal(dangerCalls.length, 0)
})

test('path confirmation buttons are removed when the turn ends', async () => {
  const edited = []
  const telegram = {
    sendMessage: async (chatId, text, extra) => {
      if (extra?.reply_markup) return { message_id: 'pc1' }
      return { message_id: 'm1' }
    },
    sendChatAction: async () => {},
    editMessageReplyMarkup: async (chatId, messageId, markup) => { edited.push({ chatId, messageId, markup }) },
  }
  const rest = { sendMessage: async () => {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe, logger: noopLogger })
  const p = conv.handleText('/send s1 test path')
  assert.ok(await until(() => registered.length > 0), 'the turn should have subscribed')
  const onEvent = registered[0].onEvent

  // The agent requests a path confirmation.
  onEvent({ type: 'chat.path_confirmation', payload: { callId: 'pc1', tool: 'bash', paths: ['/etc'], reason: 'outside' } })
  // Let the .then() from _showPathConfirmation set the messageId.
  await new Promise((r) => setImmediate(r))
  // The agent continues and the turn ends.
  onEvent({ type: 'chat.delta', payload: { messageId: 'a1', content: 'done' } })
  onEvent({ type: 'chat.done', payload: { messageId: 'a1', reason: 'complete' } })
  await p

  // The buttons were removed from the confirmation message.
  assert.equal(edited.length, 1)
  assert.equal(edited[0].messageId, 'pc1')
  assert.deepEqual(edited[0].markup, { inline_keyboard: [] })
  // The pendingPathConfirms map is cleared.
  assert.equal(conv.state.pendingPathConfirms.size, 0)
})

test('handleCallback path_confirm falls back to state.sessionId when no pendingPathConfirms', async () => {
  const confirmCalls = []
  const telegram = {
    sendMessage: async (chatId, text) => {},
    sendChatAction: async () => {},
    editMessageReplyMarkup: async () => {},
  }
  const rest = {
    sendMessage: async () => {},
    confirmPath: async (sessionId, callId, approved, alwaysAllow) => {
      confirmCalls.push({ sessionId, callId, approved, alwaysAllow })
    },
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  conv.state.sessionId = 's1'

  await conv.handleCallback('path_confirm:abc:def:allow')

  assert.equal(confirmCalls.length, 1)
  assert.equal(confirmCalls[0].sessionId, 's1')
  assert.equal(confirmCalls[0].callId, 'abc:def')
  assert.equal(confirmCalls[0].approved, true)
})

test('handleCallback path_confirm with no session says no active session', async () => {
  const sent = []
  const telegram = {
    sendMessage: async (chatId, text) => { sent.push(text) },
    sendChatAction: async () => {},
  }
  const rest = {
    sendMessage: async () => {},
    confirmPath: async () => {},
  }
  const conv = new Conversation({ chatId: 'c1', telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger })
  conv.state.sessionId = null

  await conv.handleCallback('path_confirm:abc:def:allow')

  assert.equal(sent.length, 1)
  assert.ok(sent[0].includes('Pas de session active'))
})

// ---------------------------------------------------------------------------
// Runtime: the polling loop must keep reading Telegram while a turn runs.
// Seen live: a turn waiting for a path confirmation blocked the loop, so the
// button clicks were only read once the turn ended — too late, "No pending
// path confirmation with that ID" — and every click looked like it did nothing.
// ---------------------------------------------------------------------------

function runtimeRest(overrides = {}) {
  return {
    async getLocale() { return 'fr' },
    async sendMessage() { return {} },
    async confirmPath() { return { success: true } },
    async stopSession() { return { success: true } },
    ...overrides,
  }
}

async function until(check, timeoutMs = 1000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) return false
    await sleep(10)
  }
  return true
}

test('runtime: a path confirmation click is handled while the turn waits for it', async () => {
  const telegram = fakeTelegram()
  const confirmed = []
  const rest = runtimeRest({ async confirmPath(sessionId, callId, approved) { confirmed.push({ sessionId, callId, approved }); return { success: true } } })
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest, subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 fais un ls sur /root' } })
  assert.ok(await until(() => registered.length > 0), 'the turn should have started')
  // The agent asks for a confirmation; the turn now waits for the answer.
  registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'c1', tool: 'run_command', paths: ['/root'], reason: 'outside_workdir' } })
  telegram._push({ update_id: 2, callback_query: { id: 'cb1', from: { id: 1 }, message: { message_id: 50, chat: { id: 7 } }, data: 'path_confirm:c1:allow' } })

  const handled = await until(() => confirmed.length > 0)
  r.stop()
  assert.ok(handled, 'the click must reach OpenFox while the turn is still running')
  assert.deepEqual(confirmed[0], { sessionId: 's1', callId: 'c1', approved: true })
  assert.ok(telegram.answered.includes('cb1'))
})

test('runtime: /stop is handled while a turn runs', async () => {
  const telegram = fakeTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 longue tâche' } })
  assert.ok(await until(() => registered.length > 0), 'the turn should have started')
  const before = telegram.sent.length
  telegram._push({ update_id: 2, message: { chat: { id: 7 }, from: { id: 1 }, text: '/stop' } })

  // The running turn is stopped (not "nothing to stop") without waiting for it to end.
  const handled = await until(() => registered.length === 0)
  r.stop()
  assert.ok(handled, '/stop must not wait for the running turn to end')
  assert.ok(telegram.sent.length > before)
})

test('runtime: messages of one chat still run one after the other', async () => {
  const telegram = fakeTelegram()
  const sentToOpenFox = []
  const rest = runtimeRest({ async sendMessage(sessionId, content) { sentToOpenFox.push(content); return {} } })
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest, subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 premier' } })
  telegram._push({ update_id: 2, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 second' } })
  assert.ok(await until(() => sentToOpenFox.length > 0))
  await sleep(100)
  assert.deepEqual(sentToOpenFox, ['premier'], 'the second message waits for the first turn')

  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  const second = await until(() => sentToOpenFox.length === 2)
  r.stop()
  assert.ok(second, 'the second message runs once the first turn is done')
  assert.deepEqual(sentToOpenFox, ['premier', 'second'])
})

test('runtime: the confirmation buttons are removed once answered', async () => {
  const telegram = fakeTelegram()
  const edited = []
  telegram.editMessageReplyMarkup = async (chatId, messageId) => { edited.push({ chatId, messageId }) }
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 ls' } })
  assert.ok(await until(() => registered.length > 0))
  registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'c1', tool: 'run_command', paths: ['/root'], reason: 'outside_workdir' } })
  telegram._push({ update_id: 2, callback_query: { id: 'cb1', from: { id: 1 }, message: { message_id: 50, chat: { id: 7 } }, data: 'path_confirm:c1:allow' } })

  const removed = await until(() => edited.length > 0)
  r.stop()
  assert.ok(removed, 'the buttons should be removed so they cannot be clicked twice')
  assert.deepEqual(edited[0], { chatId: 7, messageId: 50 })
})

test('TelegramClient.editMessageReplyMarkup clears the inline keyboard of a message', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true, result: true }) }
  }
  const client = new TelegramClient({ token: 'T', fetchImpl })
  await client.editMessageReplyMarkup(7, 50)
  assert.ok(calls[0].url.endsWith('/editMessageReplyMarkup'))
  assert.deepEqual(calls[0].body, { chat_id: 7, message_id: 50, reply_markup: { inline_keyboard: [] } })
})

// ---------------------------------------------------------------------------
// /stop stops the agent on OpenFox, not only the wait on the Telegram side.
// ---------------------------------------------------------------------------

test('OpenFoxRestClient.stopSession POSTs to /api/sessions/:id/stop', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ success: true }) }
    },
  })
  const res = await client.stopSession('s1')
  assert.deepEqual(res, { success: true })
  assert.ok(calls[0][0].includes('/api/sessions/s1/stop'))
  assert.equal(calls[0][1].method, 'POST')
})

test('handleText /stop stops the running session on OpenFox', async () => {
  const sent = []
  const stopped = []
  const rest = { sendMessage: async () => {}, stopSession: async (id) => { stopped.push(id); return { success: true } } }
  const { subscribe } = fakeSubscribe()
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe,
    logger: noopLogger,
  })
  const p = conv.handleText('/send s1 hello')
  await new Promise((r) => setTimeout(r, 5))
  await conv.handleText('/stop')
  await p

  assert.deepEqual(stopped, ['s1'], 'the session running the turn is stopped on the server')
  assert.ok(sent.some((t) => t.includes('Tour arrêté')))
})

test('handleText /stop still stops waiting when OpenFox cannot stop the session', async () => {
  const sent = []
  const rest = { sendMessage: async () => {}, stopSession: async () => { throw new Error('OpenFox 500: boom') } }
  const { subscribe } = fakeSubscribe()
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe,
    logger: noopLogger,
  })
  const p = conv.handleText('/send s1 hello')
  await new Promise((r) => setTimeout(r, 5))
  await conv.handleText('/stop')
  await p

  assert.ok(sent.some((t) => t.includes('boom')), `the failure is reported, got: ${JSON.stringify(sent)}`)
})

test('handleText /stop with no running turn does not call OpenFox', async () => {
  const sent = []
  let calls = 0
  const rest = { stopSession: async () => { calls++ } }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/stop')
  assert.equal(calls, 0)
  assert.ok(sent.some((t) => t.includes('Rien à arrêter')))
})

// ---------------------------------------------------------------------------
// Buttons and the reply keyboard
// ---------------------------------------------------------------------------

test('runtime: any inline keyboard is removed once one of its buttons is clicked', async () => {
  const telegram = fakeTelegram()
  const edited = []
  telegram.editMessageReplyMarkup = async (chatId, messageId) => { edited.push({ chatId, messageId }) }
  const rest = runtimeRest({ async listSessions() { return [] }, async listProjects() { return [{ id: 'p1', name: 'P' }] } })
  const r = createRuntime({ telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, callback_query: { id: 'cb1', from: { id: 1 }, message: { message_id: 61, chat: { id: 7 } }, data: 'proj:p1' } })
  const removed = await until(() => edited.length > 0)
  r.stop()
  assert.ok(removed, 'a project list must not stay clickable once a project is picked')
  assert.deepEqual(edited[0], { chatId: 7, messageId: 61 })
})

test('the reply keyboard comes with the session confirmation: icons, no slash, stays shown', async () => {
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async getSessionDetail() { return { messages: [] } } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.stage = 'pick_session'
  conv._cachedSessions = [{ id: 's1', title: 'Sess' }]
  await conv.select('1')
  const replyKeyboards = telegram.sent.map((m) => m.extra?.reply_markup).filter((k) => k?.keyboard)
  assert.ok(replyKeyboards.length > 0, 'the session confirmation carries the keyboard')
  assert.deepEqual(replyKeyboards[0].keyboard, [[KEYS.start, KEYS.stop, KEYS.agents, KEYS.status]])
  assert.deepEqual(KEYS, { start: '▶️ start', stop: '⏹ stop', agents: '🤖 agents', status: '📊 status' })
  assert.equal(replyKeyboards[0].is_persistent, true)
})


test('the keyboard keys work like their commands', async () => {
  const telegram = fakeTelegram()
  let listed = 0
  const rest = {
    async listProjects() { listed++; return [] },
    async listAgents() { return [{ id: 'builder', name: 'Builder' }] },
    async getLocale() { return 'fr' },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText(KEYS.start)
  assert.equal(listed, 1, 'the start key shows the projects like /start')
  await conv.handleText(KEYS.stop)
  assert.ok(telegram.sent.some((m) => m.text.includes('Rien à arrêter')), 'the stop key works like /stop')
  await conv.handleText(KEYS.agents)
  assert.ok(telegram.sent.some((m) => m.extra?.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data === 'agent:builder')), 'the agents key lists the agents')
})

test('a typed word without slash is not a command', async () => {
  const telegram = fakeTelegram()
  let listed = 0
  const conv = new Conversation({
    chatId: 1,
    telegram,
    rest: { async listProjects() { listed++; return [] }, async getLocale() { return 'fr' } },
    logger: noopLogger,
    subscribe: fakeSubscribe().subscribe,
  })
  await conv.handleText('start')
  await conv.handleText('stop')
  assert.equal(listed, 0, '"start" typed by hand is not /start')
  assert.ok(!telegram.sent.some((m) => m.text.includes('Rien à arrêter')), '"stop" typed by hand is not /stop')
})

test('runtime: the stop key reaches a running turn like /stop', async () => {
  const telegram = fakeTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 longue tâche' } })
  assert.ok(await until(() => registered.length > 0))
  telegram._push({ update_id: 2, message: { chat: { id: 7 }, from: { id: 1 }, text: KEYS.stop } })
  const handled = await until(() => registered.length === 0)
  r.stop()
  assert.ok(handled, 'the "stop" key must not wait for the running turn to end')
})

test('the "no active session" reply sends the current keyboard, replacing an outdated one', async () => {
  // Telegram keeps the last keyboard a bot sent: an older one (e.g. keys
  // without icons, after an update or a restart) sends text that is no longer
  // a command, which lands here.
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('start')
  const reply = telegram.sent.at(-1)
  assert.ok(reply.text.includes('Pas de session active'))
  assert.deepEqual(reply.extra?.reply_markup?.keyboard, [[KEYS.start]], "without a session only the start key")
  assert.equal(reply.extra?.reply_markup?.is_persistent, true)
})

test('creating a session and /continue also bring the keyboard', async () => {
  const telegram = fakeTelegram()
  const rest = {
    async getLocale() { return 'fr' },
    async createSession(projectId, title) { return { id: 's9', title } },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/continue s2')
  assert.deepEqual(telegram.sent.at(-1).extra?.reply_markup?.keyboard, [[KEYS.start, KEYS.stop, KEYS.agents, KEYS.status]])
})

test('help is gone: /help is no command, and no help key or button', async () => {
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/help')
  assert.ok(!telegram.sent.some((m) => /^Menu/.test(m.text)), 'no help menu')
  assert.ok(telegram.sent.at(-1).text.includes('Pas de session active'), '/help is plain text, like any other message')
  const before = telegram.sent.length
  await conv.handleCallback('help')
  assert.equal(telegram.sent.length, before, 'an old help button does nothing')
  assert.ok(!('help' in KEYS))
})

// ---------------------------------------------------------------------------
// Access: only the configured Telegram user ID drives the bot.
// ---------------------------------------------------------------------------

test('runtime: without an authorized ID, messages and clicks are ignored (fail closed)', async () => {
  const telegram = fakeTelegram()
  const warnings = []
  const logger = { ...noopLogger, warn: (msg, data) => warnings.push({ msg, data }) }
  let listed = 0
  const rest = runtimeRest({ async listProjects() { listed++; return [] } })
  const r = createRuntime({ telegram, rest, subscribe: fakeSubscribe().subscribe, logger, auth: {} })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 555 }, text: '/start' } })
  telegram._push({ update_id: 2, callback_query: { id: 'cb1', from: { id: 555 }, message: { message_id: 3, chat: { id: 7 } }, data: 'proj:p1' } })
  await sleep(150)
  r.stop()
  assert.equal(listed, 0, 'nobody may drive the bot while no ID is set')
  assert.equal(telegram.sent.length, 0)
  assert.equal(telegram.answered.length, 0)
  assert.ok(warnings.some((w) => w.data?.senderId === 555), 'the warning gives the sender ID to configure')
})

test('runtime: another user than the authorized ID is ignored', async () => {
  const telegram = fakeTelegram()
  let listed = 0
  const rest = runtimeRest({ async listProjects() { listed++; return [] } })
  const r = createRuntime({ telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 555 }, text: '/start' } })
  await sleep(150)
  r.stop()
  assert.equal(listed, 0)
  assert.equal(telegram.sent.length, 0)
})

test('register: the settings ask for the user ID only, as required', () => {
  const settingsCalls = []
  register({
    context: { settings: () => ({}), logger: noopLogger, storage: { get: () => undefined, set() {} } },
    registerSettings: (schema) => settingsCalls.push(schema),
  })
  const keys = settingsCalls[0].fields.map((f) => f.key)
  assert.ok(keys.includes('authorizedUserId'))
  assert.ok(!keys.includes('authorizedUsername'), 'the username option is gone')
  const idField = settingsCalls[0].fields.find((f) => f.key === 'authorizedUserId')
  assert.match(idField.description.fr, /Obligatoire/)
})

// ---------------------------------------------------------------------------
// Agent questions (ask_user): shown in Telegram and answerable from it.
// ---------------------------------------------------------------------------

function questionConv(overrides = {}) {
  const telegram = fakeTelegram()
  const answers = []
  const sentToSession = []
  const rest = {
    async getLocale() { return 'fr' },
    async sendMessage(sessionId, content) { sentToSession.push(content); return {} },
    async answerQuestion(sessionId, callId, answer) { answers.push({ sessionId, callId, answer }); return { success: true } },
    ...overrides,
  }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe })
  return { conv, telegram, answers, sentToSession, registered }
}

test('OpenFoxRestClient.answerQuestion POSTs {callId, answer} to /api/sessions/:id/answer', async () => {
  const calls = []
  const client = new OpenFoxRestClient({ baseUrl: 'http://x', fetchImpl: async (url, opts) => { calls.push([String(url), opts]); return { status: 200, json: async () => ({ success: true }) } } })
  await client.answerQuestion('s1', 'q1', 'oui')
  assert.ok(calls[0][0].includes('/api/sessions/s1/answer'))
  assert.equal(calls[0][1].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0][1].body), { callId: 'q1', answer: 'oui' })
})

test('a choice question shows one button per option and a click answers it', async () => {
  const { conv, telegram, answers, registered } = questionConv()
  const turn = conv.handleText('/send s1 aide-moi')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.ask_user', payload: { callId: 'q1', question: 'Quel langage ?', type: 'choice', options: [{ value: 'ts', label: 'TypeScript' }, { value: 'py', label: 'Python' }] } })
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'waiting_for_user' } })
  const q = telegram.sent.at(-1)
  assert.ok(q.text.includes('Quel langage ?'))
  const buttons = q.extra.reply_markup.inline_keyboard.flat()
  assert.deepEqual(buttons.map((b) => b.text), ['TypeScript', 'Python'])

  await conv.handleCallback(buttons[1].callback_data)
  assert.deepEqual(answers, [{ sessionId: 's1', callId: 'q1', answer: 'py' }])
  registered[0].onEvent({ type: 'chat.delta', payload: { messageId: 'm2', content: 'Va pour Python.' } })
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm2', reason: 'complete' } })
  await turn
  assert.ok(telegram.sent.some((m) => m.text === 'Va pour Python.'), 'waiting_for_user does not end the turn; the answer is forwarded')
})

test('a confirm question answers yes or no', async () => {
  const { conv, telegram, answers, registered } = questionConv()
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.ask_user', payload: { callId: 'q2', question: 'Je supprime ?', type: 'confirm' } })
  const buttons = telegram.sent.at(-1).extra.reply_markup.inline_keyboard.flat()
  assert.deepEqual(buttons.map((b) => b.text), ['Oui', 'Non'])
  await conv.handleCallback(buttons[1].callback_data)
  assert.deepEqual(answers, [{ sessionId: 's1', callId: 'q2', answer: 'no' }])
  conv.stopTurn()
  await turn
})

test('a text question is answered by the next message, not sent as a new turn', async () => {
  const { conv, telegram, answers, sentToSession, registered } = questionConv()
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.ask_user', payload: { callId: 'q3', question: 'Quel nom ?', type: 'text' } })
  assert.ok(telegram.sent.at(-1).text.includes('Quel nom ?'))
  await conv.handleText('Renard')
  assert.deepEqual(answers, [{ sessionId: 's1', callId: 'q3', answer: 'Renard' }])
  assert.deepEqual(sentToSession, ['go'], 'the answer is not a new message to the session')
  conv.stopTurn()
  await turn
})

test('the turn watchdog does not expire while a question waits for its answer', async () => {
  const timer = fakeTimer()
  const telegram = fakeTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe, timer })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.ask_user', payload: { callId: 'q4', question: 'Alors ?', type: 'text' } })
  for (let id = 1; id <= 10; id++) timer._fireTimeout(id)
  assert.ok(!telegram.sent.some((m) => m.text.includes('expiré')), 'no expiry while waiting for the user')
  assert.equal(registered.length, 1, 'the turn keeps listening')
  conv.stopTurn()
  await turn
})

test('runtime: an answer to a text question is handled while the turn runs', async () => {
  const telegram = fakeTelegram()
  const answers = []
  const rest = runtimeRest({ async answerQuestion(sessionId, callId, answer) { answers.push(answer); return { success: true } } })
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest, subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 go' } })
  assert.ok(await until(() => registered.length > 0))
  registered[0].onEvent({ type: 'chat.ask_user', payload: { callId: 'q5', question: 'Quel nom ?', type: 'text' } })
  telegram._push({ update_id: 2, message: { chat: { id: 7 }, from: { id: 1 }, text: 'Renard' } })
  const answered = await until(() => answers.length > 0)
  r.stop()
  assert.ok(answered, 'the answer must not wait behind the turn it unblocks')
  assert.deepEqual(answers, ['Renard'])
})

// ---------------------------------------------------------------------------
// The active session survives a plugin or OpenFox restart.
// ---------------------------------------------------------------------------

function memoryStorage() {
  const data = new Map()
  return { get: (k) => data.get(k), set: (k, v) => data.set(k, v), data }
}

test('the active session is restored after a restart', async () => {
  const storage = memoryStorage()
  const sentToSession = []
  const rest = {
    async getLocale() { return 'fr' },
    async getSessionDetail() { return { messages: [] } },
    async sendMessage(sessionId, content) { sentToSession.push({ sessionId, content }); return {} },
  }
  const before = new Conversation({ chatId: 7, telegram: fakeTelegram(), rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe, storage })
  before.state.projectId = 'p1'
  before.state.stage = 'pick_session'
  before._cachedSessions = [{ id: 's1', title: 'Sess' }]
  await before.handleText('1')

  // Restart: a new conversation for the same chat, same storage.
  const { subscribe, registered } = fakeSubscribe()
  const telegram = fakeTelegram()
  const after = new Conversation({ chatId: 7, telegram, rest, logger: noopLogger, subscribe, storage })
  const turn = after.handleText('bonjour')
  await sleep(5)
  assert.deepEqual(sentToSession, [{ sessionId: 's1', content: 'bonjour' }], 'the message goes to the restored session')
  assert.ok(!telegram.sent.some((m) => m.text.includes('Pas de session active')))
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await turn
})

test('a chat with nothing stored starts without a session', () => {
  const conv = new Conversation({ chatId: 8, telegram: fakeTelegram(), rest: {}, logger: noopLogger, subscribe: fakeSubscribe().subscribe, storage: memoryStorage() })
  assert.equal(conv.state.sessionId ?? null, null)
})

test('runtime: the storage reaches the conversations', async () => {
  const storage = memoryStorage()
  storage.set('chat:7', JSON.stringify({ projectId: 'p1', sessionId: 's1' }))
  const sentToSession = []
  const rest = runtimeRest({ async sendMessage(sessionId, content) { sentToSession.push(sessionId); return {} } })
  const r = createRuntime({ telegram: fakeTelegram(), rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 }, storage })
  r.start()
  r.stop()
  const telegram = fakeTelegram()
  const r2 = createRuntime({ telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 }, storage })
  r2.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: 'salut' } })
  const ok = await until(() => sentToSession.length > 0)
  r2.stop()
  assert.ok(ok)
  assert.deepEqual(sentToSession, ['s1'])
})

// ---------------------------------------------------------------------------
// Night mode toggle and /status
// ---------------------------------------------------------------------------

function sessionRest(session, overrides = {}) {
  return {
    async getLocale() { return 'fr' },
    async listAgents() { return [{ id: 'builder', name: 'Builder' }] },
    async listProjects() { return [{ id: 'p1', name: 'Mon projet' }] },
    async getSessionDetail() { return { session, messages: [], contextState: { currentTokens: 12000, maxTokens: 80000 } } },
    ...overrides,
  }
}

test('OpenFoxRestClient.setNightMode PUTs {nightMode} to /api/sessions/:id/night-mode', async () => {
  const calls = []
  const client = new OpenFoxRestClient({ baseUrl: 'http://x', fetchImpl: async (url, opts) => { calls.push([String(url), opts]); return { status: 200, json: async () => ({ session: { nightMode: true } }) } } })
  await client.setNightMode('s1', true)
  assert.ok(calls[0][0].includes('/api/sessions/s1/night-mode'))
  assert.equal(calls[0][1].method, 'PUT')
  assert.deepEqual(JSON.parse(calls[0][1].body), { nightMode: true })
})

test('the agents list ends with a night mode button showing its state, and it toggles', async () => {
  const toggled = []
  const telegram = fakeTelegram()
  const rest = sessionRest({ id: 's1', title: 'Sess', nightMode: false }, { async setNightMode(id, on) { toggled.push({ id, on }); return { session: { nightMode: on } } } })
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.sessionId = 's1'
  conv.state.stage = 'active'
  await conv.handleText('/agents')
  const buttons = telegram.sent.at(-1).extra.reply_markup.inline_keyboard.flat()
  const night = buttons.at(-1)
  await conv.handleCallback(night.callback_data)
  assert.deepEqual(toggled, [{ id: 's1', on: true }])
})

test('without an active session the agents list has no night mode button', async () => {
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: sessionRest({}), logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/agents')
  const buttons = telegram.sent.at(-1).extra.reply_markup.inline_keyboard.flat()
  assert.ok(!buttons.some((b) => /nuit/i.test(b.text)))
})

test('the session confirmation warns when night mode is on', async () => {
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: sessionRest({ id: 's1', title: 'Sess', nightMode: true }), logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.stage = 'pick_session'
  conv._cachedSessions = [{ id: 's1', title: 'Sess' }]
  await conv.select('1')
  assert.match(telegram.sent.at(-1).text, /🌙/)
})

test('/status shows the project, session, agent, night mode, activity and context', async () => {
  const telegram = fakeTelegram()
  const rest = sessionRest({ id: 's1', title: 'Plugin Telegram', projectId: 'p1', mode: 'builder', nightMode: true, isRunning: true })
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.projectId = 'p1'
  conv.state.sessionId = 's1'
  conv.state.stage = 'active'
  await conv.handleText('/status')
  const text = telegram.sent.at(-1).text
  for (const part of ['Mon projet', 'Plugin Telegram', 'builder', 'Mode nuit', 'en cours', '12', '80']) assert.ok(text.includes(part), `missing "${part}" in: ${text}`)
})

test('/status without an active session says so', async () => {
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: sessionRest({}), logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/status')
  assert.ok(telegram.sent.at(-1).text.includes('Pas de session active'))
})

// ---------------------------------------------------------------------------
// The agent's markdown is shown formatted (Telegram HTML), plain as a fallback.
// ---------------------------------------------------------------------------

test('markdownToTelegramHtml converts the common markdown', () => {
  assert.equal(markdownToTelegramHtml('**gras** et *italique* et ~~barré~~'), '<b>gras</b> et <i>italique</i> et <s>barré</s>')
  assert.equal(markdownToTelegramHtml('le code `a < b` ici'), 'le code <code>a &lt; b</code> ici')
  assert.equal(markdownToTelegramHtml('[docs](https://ex.com/a?b=1&c=2)'), '<a href="https://ex.com/a?b=1&amp;c=2">docs</a>')
  assert.equal(markdownToTelegramHtml('## Titre'), '<b>Titre</b>')
  assert.equal(markdownToTelegramHtml('- un\n* deux'), '• un\n• deux')
  assert.equal(markdownToTelegramHtml('> cité'), '<blockquote>cité</blockquote>')
  assert.equal(markdownToTelegramHtml('1 < 2 & 3 > 2'), '1 &lt; 2 &amp; 3 &gt; 2')
})

test('markdownToTelegramHtml keeps code blocks verbatim, escaped, with their language', () => {
  const md = 'Avant\n```ts\nconst a = **b** < c\n```\nAprès'
  assert.equal(
    markdownToTelegramHtml(md),
    'Avant\n<pre><code class="language-ts">const a = **b** &lt; c</code></pre>\nAprès',
  )
})

test('markdownToTelegramHtml leaves snake_case and lone stars alone', () => {
  assert.equal(markdownToTelegramHtml('my_var_name et 2 * 3 * 4'), 'my_var_name et 2 * 3 * 4')
})

test('the final answer is sent formatted', async () => {
  const telegram = fakeTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Voici **le résultat**.' } })
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await turn
  await sleep(5)
  const last = telegram.sent.at(-1)
  assert.equal(last.text, 'Voici <b>le résultat</b>.')
  assert.equal(last.extra?.parse_mode, 'HTML')
})

test('a chunk Telegram cannot parse is sent as plain text', async () => {
  const sent = []
  const telegram = {
    ...fakeTelegram(),
    async sendMessage(chatId, text, extra) {
      if (extra?.parse_mode === 'HTML') throw new Error("Telegram 400: Bad Request: can't parse entities")
      sent.push({ text, extra })
    },
  }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Voici **le résultat**.' } })
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await turn
  await sleep(5)
  assert.deepEqual(sent.at(-1), { text: 'Voici **le résultat**.', extra: {} })
})

// ---------------------------------------------------------------------------
// Progress: one message per turn, edited as the agent works.
// ---------------------------------------------------------------------------

function progressTelegram() {
  const t = fakeTelegram()
  let nextId = 100
  const edits = []
  const base = t.sendMessage
  t.sendMessage = async (chatId, text, extra) => {
    await base(chatId, text, extra)
    return { message_id: nextId++ }
  }
  t.editMessageText = async (chatId, messageId, text, extra) => { edits.push({ messageId, text, extra }) }
  t.editMessageReplyMarkup = async (chatId, messageId, markup) => { edits.push({ messageId, markup }) }
  t.edits = edits
  return t
}

test('TelegramClient.sendMessage returns the sent message and editMessageText edits one', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) }
  }
  const client = new TelegramClient({ token: 'T', fetchImpl })
  const sent = await client.sendMessage(7, 'salut')
  assert.equal(sent.message_id, 42)
  await client.editMessageText(7, 42, 'mis à jour')
  assert.ok(calls[1].url.endsWith('/editMessageText'))
  assert.deepEqual(calls[1].body, { chat_id: 7, message_id: 42, text: 'mis à jour' })
})

test('tool calls show in one progress message, edited as they run and finish', async () => {
  const telegram = progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  const ev = registered[0].onEvent
  ev({ type: 'chat.tool_call', payload: { callId: 'c1', tool: 'read_file', args: { path: 'a.ts' } } })
  await sleep(20)
  ev({ type: 'chat.tool_result', payload: { callId: 'c1', result: { success: true } } })
  await sleep(20)
  ev({ type: 'chat.tool_call', payload: { callId: 'c2', tool: 'run_command', args: { command: 'npm test' } } })
  await sleep(20)
  ev({ type: 'chat.tool_result', payload: { callId: 'c2', result: { success: false } } })
  await sleep(20)
  ev({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await turn
  await sleep(20)

  const progress = telegram.sent.filter((m) => /read_file|run_command/.test(m.text))
  assert.equal(progress.length, 1, `one progress message, got: ${JSON.stringify(telegram.sent.map((m) => m.text))}`)
  assert.equal(progress[0].text, '⏳ read_file · a.ts')
  assert.equal(telegram.edits.at(-1).messageId, 100)
  assert.equal(telegram.edits.at(-1).text, '✓ read_file · a.ts\n✗ run_command · npm test')
})

test('a long turn keeps the last 15 steps in its progress message', async () => {
  const telegram = progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  for (let i = 1; i <= 20; i++) {
    registered[0].onEvent({ type: 'chat.tool_call', payload: { callId: `c${i}`, tool: 'read_file', args: { path: `f${i}.ts` } } })
    registered[0].onEvent({ type: 'chat.tool_result', payload: { callId: `c${i}`, result: { success: true } } })
  }
  await sleep(50)
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await turn
  await sleep(50)
  const text = telegram.edits.at(-1)?.text ?? telegram.sent.findLast((m) => m.text.includes('read_file')).text
  const lines = text.split('\n')
  assert.equal(lines.length, 16, text)
  assert.match(lines[0], /5 étapes précédentes/)
  assert.equal(lines.at(-1), '✓ read_file · f20.ts')
})

// ---------------------------------------------------------------------------
// A message sent while the agent works goes to OpenFox's queue at once.
// ---------------------------------------------------------------------------

test('a message sent during a turn is queued on OpenFox and its answer forwarded too', async () => {
  const telegram = fakeTelegram()
  const sentToSession = []
  const rest = { async getLocale() { return 'fr' }, async sendMessage(sessionId, content) { sentToSession.push({ sessionId, content }); return {} } }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 première tâche')
  await sleep(5)
  await conv.handleText('et ensuite ceci')
  assert.deepEqual(sentToSession.map((m) => m.content), ['première tâche', 'et ensuite ceci'], 'sent to OpenFox at once')
  assert.ok(telegram.sent.at(-1).text.includes('file'), 'the user is told it is queued')

  const ev = registered[0].onEvent
  ev({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Réponse 1' } })
  ev({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await sleep(10)
  assert.equal(registered.length, 1, 'still listening for the queued message')
  ev({ type: 'chat.delta', payload: { messageId: 'm2', content: 'Réponse 2' } })
  ev({ type: 'chat.done', payload: { messageId: 'm2', reason: 'complete' } })
  await turn
  const texts = telegram.sent.map((m) => m.text)
  assert.ok(texts.indexOf('Réponse 1') < texts.indexOf('Réponse 2'), JSON.stringify(texts))
})

test('a command during a turn is not queued on OpenFox', async () => {
  const sentToSession = []
  const rest = { async getLocale() { return 'fr' }, async sendMessage(sessionId, content) { sentToSession.push(content); return {} }, async stopSession() { return {} } }
  const { subscribe } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram: fakeTelegram(), rest, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 tâche')
  await sleep(5)
  await conv.handleText('/stop')
  await turn
  assert.deepEqual(sentToSession, ['tâche'])
})

test('runtime: a message during a turn reaches OpenFox without waiting for the turn', async () => {
  const telegram = fakeTelegram()
  const sentToSession = []
  const rest = runtimeRest({ async sendMessage(sessionId, content) { sentToSession.push(content); return {} } })
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest, subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 longue tâche' } })
  assert.ok(await until(() => registered.length > 0))
  telegram._push({ update_id: 2, message: { chat: { id: 7 }, from: { id: 1 }, text: 'pendant ce temps' } })
  const ok = await until(() => sentToSession.length === 2)
  r.stop()
  assert.ok(ok, JSON.stringify(sentToSession))
})

test('the turn watchdog restarts on activity, so a long busy turn does not expire', async () => {
  const timer = fakeTimer()
  const telegram = fakeTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe, timer })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.tool_call', payload: { callId: 'c1', tool: 'read_file', args: { path: 'a' } } })
  timer._fireTimeout(1)
  assert.ok(!telegram.sent.some((m) => m.text.includes('expiré')), 'the first deadline was moved by the activity')
  timer._fireTimeout(2)
  await turn
  assert.ok(telegram.sent.some((m) => m.text.includes('expiré')), 'still expires after inactivity')
})

// ---------------------------------------------------------------------------
// Photos and files become attachments of the message.
// ---------------------------------------------------------------------------

const bytes = (s) => new TextEncoder().encode(s)

test('toAttachment: images and PDFs as data URLs, text as text, other binaries refused', () => {
  const img = toAttachment({ bytes: bytes('abc'), filename: 'photo.jpg', mimeType: 'image/jpeg' })
  assert.equal(img.mimeType, 'image/jpeg')
  assert.equal(img.data, 'data:image/jpeg;base64,YWJj')
  assert.equal(img.size, 3)
  assert.equal(img.filename, 'photo.jpg')
  assert.ok(img.id)
  assert.equal(toAttachment({ bytes: bytes('%PDF'), filename: 'a.pdf', mimeType: 'application/pdf' }).data, 'data:application/pdf;base64,JVBERg==')
  assert.equal(toAttachment({ bytes: bytes('{"a":1}'), filename: 'a.json', mimeType: 'application/json' }).data, '{"a":1}')
  // Telegram often sends code files as application/octet-stream: valid UTF-8 is text.
  const code = toAttachment({ bytes: bytes('const é = 1'), filename: 'a.ts', mimeType: 'application/octet-stream' })
  assert.equal(code.data, 'const é = 1')
  assert.equal(code.mimeType, 'text/plain')
  assert.equal(toAttachment({ bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00]), filename: 'a.zip', mimeType: 'application/zip' }), null)
})

test('a photo with a caption is sent to the session as an attachment', async () => {
  const telegram = fakeTelegram()
  telegram.downloadFile = async (fileId) => (fileId === 'big' ? bytes('IMG') : null)
  const sent = []
  const rest = runtimeRest({ async sendMessage(sessionId, content, attachments) { sent.push({ sessionId, content, attachments }); return {} } })
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe })
  conv.state.sessionId = 's1'
  conv.state.stage = 'active'
  const turn = conv.handleFile({ fileId: 'big', filename: 'photo.jpg', mimeType: 'image/jpeg', size: 3 }, 'que vois-tu ?')
  assert.ok(await until(() => sent.length === 1))
  assert.equal(sent[0].content, 'que vois-tu ?')
  assert.equal(sent[0].attachments[0].data, 'data:image/jpeg;base64,SU1H')
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm', reason: 'complete' } })
  await turn
})

test('a file without an active session, too big, or unsupported is refused with a message', async () => {
  const telegram = fakeTelegram()
  telegram.downloadFile = async () => new Uint8Array([0xff, 0xfe, 0x00, 0x01])
  const sent = []
  const rest = runtimeRest({ async sendMessage(...a) { sent.push(a); return {} } })
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleFile({ fileId: 'f', filename: 'a.bin', mimeType: 'application/octet-stream', size: 4 }, '')
  assert.match(telegram.sent.at(-1).text, /session/i)
  conv.state.sessionId = 's1'
  await conv.handleFile({ fileId: 'f', filename: 'a.bin', mimeType: 'application/octet-stream', size: 50 * 1024 * 1024 }, '')
  assert.match(telegram.sent.at(-1).text, /volumineux/)
  await conv.handleFile({ fileId: 'f', filename: 'a.bin', mimeType: 'application/octet-stream', size: 4 }, '')
  assert.match(telegram.sent.at(-1).text, /pris en charge/)
  assert.equal(sent.length, 0)
})

test('runtime: a photo message takes its largest size and its caption', async () => {
  const telegram = fakeTelegram()
  const asked = []
  telegram.downloadFile = async (id) => { asked.push(id); return bytes('x') }
  const sent = []
  const rest = runtimeRest({ async sendMessage(sessionId, content, attachments) { sent.push({ content, attachments }); return {} } })
  const storage = { get: () => JSON.stringify({ projectId: 'p', sessionId: 's1' }), set() {} }
  const r = createRuntime({ telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 }, storage })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, caption: 'regarde', photo: [{ file_id: 'small', file_size: 1 }, { file_id: 'big', file_size: 9 }] } })
  const ok = await until(() => sent.length === 1)
  r.stop()
  assert.ok(ok)
  assert.deepEqual(asked, ['big'])
  assert.equal(sent[0].content, 'regarde')
  assert.equal(sent[0].attachments[0].mimeType, 'image/jpeg')
})

test('TelegramClient.downloadFile gets the file path then the bytes', async () => {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (url.endsWith('/getFile')) return { status: 200, async json() { return { ok: true, result: { file_path: 'photos/a.jpg' } } } }
    return { status: 200, ok: true, async arrayBuffer() { return bytes('JPG').buffer } }
  }
  const tg = new TelegramClient({ token: '123:abc', fetchImpl })
  const data = await tg.downloadFile('F1')
  assert.equal(new TextDecoder().decode(data), 'JPG')
  assert.equal(urls[1], 'https://api.telegram.org/file/bot123:abc/photos/a.jpg')
})

test('OpenFoxRestClient.sendMessage sends attachments only when there are some', async () => {
  const bodies = []
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, async json() { return {} } } }
  const rest = new OpenFoxRestClient({ baseUrl: 'http://x', fetchImpl })
  await rest.sendMessage('s', 'hi')
  await rest.sendMessage('s', '', [{ id: 'a' }])
  assert.deepEqual(bodies, [{ content: 'hi' }, { content: '', attachments: [{ id: 'a' }] }])
})

test('the status key and the /status command in the bot menu', async () => {
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'status'), '/status is in the bot menu')
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText(KEYS.status)
  assert.ok(telegram.sent.at(-1).text.includes('Pas de session active'), JSON.stringify(telegram.sent.at(-1)))
})

test('the agents list shows only the builder and the planner', async () => {
  const telegram = fakeTelegram()
  const rest = {
    async getLocale() { return 'fr' },
    async listAgents() {
      return ['code_reviewer', 'planner', 'explorer', 'builder', 'verifier'].map((id) => ({ id, name: id }))
    },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/agents')
  const ids = telegram.sent.at(-1).extra.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)
  assert.deepEqual(ids, ['agent:builder', 'agent:planner'])
})

test('the keys under the input: only start without a session, all of them with one', async () => {
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async getSessionDetail() { return { session: {}, messages: [] } } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText(KEYS.status)
  assert.deepEqual(telegram.sent.at(-1).extra?.reply_markup?.keyboard, [[KEYS.start]])
  await conv.handleText('/continue s2')
  assert.deepEqual(telegram.sent.at(-1).extra?.reply_markup?.keyboard, [[KEYS.start, KEYS.stop, KEYS.agents, KEYS.status]])
})

test('the agents list is headed by the current agent, not "Agents :"', async () => {
  const telegram = fakeTelegram()
  const rest = {
    async getLocale() { return 'fr' },
    async listAgents() { return [{ id: 'builder', name: 'Builder' }, { id: 'planner', name: 'Planner' }] },
    async getSessionDetail() { return { session: { mode: 'planner', nightMode: false } } },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/agents')
  assert.equal(telegram.sent.at(-1).text, 'Choisis un agent :')
  conv.state.sessionId = 's1'
  await conv.handleText('/agents')
  assert.equal(telegram.sent.at(-1).text, '🤖 Agent actuel : Planner')
})

test('start closes the session and a short message brings back the start key alone', async () => {
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async listProjects() { return [{ id: 'p1', name: 'Projet 1' }] } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.sessionId = 's1'
  await conv.handleText(KEYS.start)
  const [keys, list] = telegram.sent.slice(-2)
  assert.equal(keys.text, '📂 Projets')
  assert.deepEqual(keys.extra?.reply_markup?.keyboard, [[KEYS.start]])
  assert.equal(list.extra.reply_markup.inline_keyboard[0][0].callback_data, 'proj:p1')
  assert.equal(conv.state.sessionId, null)
})

test('choosing an agent names the session, not only its id', async () => {
  const telegram = fakeTelegram()
  const rest = {
    async getLocale() { return 'fr' },
    async setSessionMode(id, mode) { return { id, mode, metadata: { title: 'Plugin Telegram' } } },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.sessionId = 's-123'
  await conv.handleCallback('agent:planner')
  assert.equal(telegram.sent.at(-1).text, 'Agent défini sur "planner" pour la session « Plugin Telegram ».')
})

test('runtime: choosing an agent deletes the agents list message', async () => {
  const telegram = fakeTelegram()
  const deleted = []
  const edited = []
  telegram.deleteMessage = async (chatId, messageId) => { deleted.push({ chatId, messageId }) }
  telegram.editMessageReplyMarkup = async (chatId, messageId) => { edited.push({ chatId, messageId }) }
  const rest = runtimeRest({ async setSessionMode(id, mode) { return { id, mode } } })
  const storage = { get: () => JSON.stringify({ projectId: 'p', sessionId: 's1' }), set() {} }
  const r = createRuntime({ telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 }, storage })
  r.start()
  telegram._push({ update_id: 1, callback_query: { id: 'cb1', from: { id: 1 }, message: { message_id: 60, chat: { id: 7 } }, data: 'agent:planner' } })
  const ok = await until(() => deleted.length > 0)
  r.stop()
  assert.ok(ok, 'the list message is deleted')
  assert.deepEqual(deleted[0], { chatId: 7, messageId: 60 })
  assert.equal(edited.length, 0)
})

test('TelegramClient.deleteMessage calls deleteMessage', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, async json() { return { ok: true, result: true } } } }
  await new TelegramClient({ token: '1:a', fetchImpl }).deleteMessage(7, 60)
  assert.ok(calls[0].url.endsWith('/deleteMessage'))
  assert.deepEqual(calls[0].body, { chat_id: 7, message_id: 60 })
})

test('runtime: a click in the projects, sessions or agents list deletes the list', async () => {
  for (const data of ['proj:p1', 'new_proj', 'sess:s1', 'new_sess', 'reset', 'agent:builder', 'night:toggle']) {
    const telegram = fakeTelegram()
    const deleted = []
    telegram.deleteMessage = async (chatId, messageId) => { deleted.push(messageId) }
    telegram.editMessageReplyMarkup = async () => {}
    const rest = runtimeRest({
      async listProjects() { return [] }, async listSessions() { return [] },
      async setSessionMode(id, mode) { return { id, mode } }, async getSessionDetail() { return { session: {} } }, async setNightMode() { return {} },
    })
    const r = createRuntime({ telegram, rest, subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 } })
    r.start()
    telegram._push({ update_id: 1, callback_query: { id: 'cb', from: { id: 1 }, message: { message_id: 70, chat: { id: 7 } }, data } })
    const ok = await until(() => deleted.length > 0)
    r.stop()
    assert.ok(ok, `${data} deletes the list`)
  }
})

test('runtime: answering a confirmation keeps the message and only removes its buttons', async () => {
  const telegram = fakeTelegram()
  const deleted = []
  const edited = []
  telegram.deleteMessage = async (c, m) => { deleted.push(m) }
  telegram.editMessageReplyMarkup = async (c, m) => { edited.push(m) }
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, callback_query: { id: 'cb', from: { id: 1 }, message: { message_id: 71, chat: { id: 7 } }, data: 'path_confirm:c1:allow' } })
  const ok = await until(() => edited.length > 0)
  r.stop()
  assert.ok(ok)
  assert.deepEqual(deleted, [])
})

test('the sessions list names its project (the projects list is deleted)', async () => {
  const telegram = fakeTelegram()
  const rest = {
    async getLocale() { return 'fr' },
    async listProjects() { return [{ id: 'p1', name: 'OpenFox' }] },
    async listSessions() { return [{ id: 's1', title: 'S1' }] },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleCallback('proj:p1')
  assert.equal(telegram.sent.at(-1).text, '📁 OpenFox\nChoisissez une session :')
})

test('a long command folds into an expandable quote in the progress message', async () => {
  const telegram = progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  const ev = registered[0].onEvent
  const long = 'cd /repo && npm run build && node scripts/check.js --all --verbose 2>&1 | grep -v "<warn>"'
  ev({ type: 'chat.tool_call', payload: { callId: 'c1', tool: 'run_command', args: { command: long } } })
  await sleep(5)
  const first = telegram.sent.at(-1)
  assert.equal(first.extra?.parse_mode, 'HTML')
  assert.equal(first.text, `⏳ run_command\n<blockquote expandable>${long.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</blockquote>`)
  ev({ type: 'chat.tool_call', payload: { callId: 'c2', tool: 'run_command', args: { command: 'ls <dir>' } } })
  await sleep(5)
  assert.ok(telegram.edits.at(-1).text.endsWith('\n⏳ run_command · ls &lt;dir&gt;'), telegram.edits.at(-1).text)
  assert.equal(telegram.edits.at(-1).extra?.parse_mode, 'HTML')
  ev({ type: 'chat.done', payload: { messageId: 'm', reason: 'complete' } })
  await turn
})

test('the progress message falls back to plain text when Telegram rejects the HTML', async () => {
  const telegram = progressTelegram()
  const base = telegram.sendMessage
  telegram.sendMessage = async (chatId, text, extra) => {
    if (extra?.parse_mode === 'HTML') throw new Error("Telegram 400: can't parse entities")
    return base(chatId, text, extra)
  }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.tool_call', payload: { callId: 'c1', tool: 'run_command', args: { command: 'ls <dir>' } } })
  await sleep(5)
  assert.equal(telegram.sent.at(-1).text, '⏳ run_command · ls <dir>')
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm', reason: 'complete' } })
  await turn
})

test('a very long command is cut in the progress message', async () => {
  const telegram = progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  for (let i = 0; i < 15; i++) registered[0].onEvent({ type: 'chat.tool_call', payload: { callId: `c${i}`, tool: 'run_command', args: { command: 'x'.repeat(3000) } } })
  await sleep(20)
  const last = telegram.edits.at(-1)?.text ?? telegram.sent.at(-1).text
  assert.ok(last.replace(/<[^>]+>/g, '').length <= 4000, `visible length ${last.length}`)
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm', reason: 'complete' } })
  await turn
})

test('runtime: status and agents answer during a turn, start still waits', async () => {
  const telegram = fakeTelegram()
  let detailCalls = 0
  let agentCalls = 0
  const rest = runtimeRest({
    async getSessionDetail() { detailCalls++; return { session: { mode: 'builder' } } },
    async listAgents() { agentCalls++; return [{ id: 'builder', name: 'Builder' }] },
    async listProjects() { return [] },
  })
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest, subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 longue tâche' } })
  assert.ok(await until(() => registered.length > 0))
  telegram._push({ update_id: 2, message: { chat: { id: 7 }, from: { id: 1 }, text: KEYS.status } })
  telegram._push({ update_id: 3, message: { chat: { id: 7 }, from: { id: 1 }, text: '/agents' } })
  telegram._push({ update_id: 4, message: { chat: { id: 7 }, from: { id: 1 }, text: KEYS.start } })
  const ok = await until(() => agentCalls > 0 && detailCalls > 0)
  await sleep(50)
  const startWaited = !telegram.sent.some((m) => m.text === '📂 Projets')
  r.stop()
  assert.ok(ok, 'status and agents answered during the turn')
  assert.ok(startWaited, 'start waits for the turn')
})

test('a long message in the history keeps its end, marked as cut', async () => {
  const telegram = fakeTelegram()
  const long = `DÉBUT ${'x'.repeat(1000)} FIN`
  const rest = {
    async getLocale() { return 'fr' },
    async getSessionDetail() { return { session: {}, messages: [{ role: 'user', content: 'court' }, { role: 'assistant', content: long }] } },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/continue s1')
  conv.state.sessionId = 's1'
  await conv.showSessionActive('S1')
  const text = telegram.sent.at(-1).text
  assert.ok(text.includes('👤 Vous : court'), text)
  assert.ok(text.includes(`🤖 Agent : …${long.slice(-500)}`), 'the end of the message, after an ellipsis')
  assert.ok(!text.includes('DÉBUT'))
})

test('the characters kept per history message are a plugin setting', async () => {
  const settingsCalls = []
  register({
    context: { settings: () => ({}), logger: noopLogger, storage: { get: () => undefined, set() {} } },
    registerSettings: (schema) => settingsCalls.push(schema),
  })
  const field = settingsCalls[0].fields.find((f) => f.key === 'historyChars')
  assert.ok(field, 'historyChars setting')
  assert.equal(field.default, '500')
  assert.ok(field.label.fr && field.label.en && field.description.fr && field.description.en)

  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async getSessionDetail() { return { session: {}, messages: [{ role: 'assistant', content: 'abcdefghij' }] } } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe, historyChars: 4 })
  conv.state.sessionId = 's1'
  await conv.showSessionActive('S1')
  assert.ok(telegram.sent.at(-1).text.includes('🤖 Agent : …ghij'), telegram.sent.at(-1).text)
})

test('history settings and the authorized ID are read live, without a restart', async () => {
  let chars = 4
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async getSessionDetail() { return { session: {}, messages: [{ role: 'assistant', content: 'abcdefghij' }] } } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe, historyChars: () => chars, historyCount: () => 6 })
  conv.state.sessionId = 's1'
  await conv.showSessionActive('S1')
  assert.ok(telegram.sent.at(-1).text.includes('🤖 Agent : …ghij'))
  chars = 2
  await conv.showSessionActive('S1')
  assert.ok(telegram.sent.at(-1).text.includes('🤖 Agent : …ij'), telegram.sent.at(-1).text)
})

test('the bot token description says a restart applies it', () => {
  const settingsCalls = []
  register({
    context: { settings: () => ({}), logger: noopLogger, storage: { get: () => undefined, set() {} } },
    registerSettings: (schema) => settingsCalls.push(schema),
  })
  const token = settingsCalls[0].fields.find((f) => f.key === 'botToken')
  assert.match(token.description.fr, /redémarr/)
  assert.match(token.description.en, /restart/i)
})

// ---------------------------------------------------------------------------
// Status panel, opened from the plugin's row in the plugins menu.
// ---------------------------------------------------------------------------

const flatText = (nodes) => JSON.stringify(nodes)

function fakeRegistry(settings = {}) {
  const r = { actions: [], panels: [], rpcs: {}, settingsCalls: [] }
  r.registry = {
    context: { settings: () => settings, logger: noopLogger, storage: { get: () => undefined, set() {} } },
    registerSettings: (s) => r.settingsCalls.push(s),
    registerUiAction: (a) => r.actions.push(a),
    registerUiPanel: (p) => r.panels.push(p),
    registerRpc: (m, h) => { r.rpcs[m] = h },
  }
  return r
}

test('register: the plugin row opens a status panel, even without a bot token', async () => {
  const r = fakeRegistry({})
  register(r.registry)
  const menu = r.actions.find((a) => a.slot === 'plugin.menu')
  assert.ok(menu, 'plugin.menu action')
  assert.deepEqual(menu.onActivate, { kind: 'rpc', method: 'openStatus' })
  assert.equal(menu.label.fr, 'Telegram')
  const panel = r.panels.find((p) => p.id === 'status')
  assert.equal(panel.kind, 'declarative')
  assert.ok(flatText(panel.footer).includes('openSettings'))
  const opened = await r.rpcs.openStatus({}, {})
  assert.equal(opened.openPanel, 'status')
  assert.match(flatText(opened.content), /Aucun jeton/)
  const init = await r.rpcs.initPanel({ panelId: 'status' }, {})
  assert.ok(Array.isArray(init.content))
  assert.ok(Array.isArray((await r.rpcs.refreshStatus({}, {})).content))
})

test('statusPanelContent: bot, connection, authorized ID and conversations', () => {
  const nodes = statusPanelContent({
    tokenSet: true,
    authorizedUserId: 123456789,
    bot: 'mon_bot',
    connection: 'ok',
    chats: [{ chatId: 7, project: 'OpenFox', session: 'Plugin Telegram', mode: 'builder', running: true }],
  })
  const text = flatText(nodes)
  for (const s of ['@mon_bot', '123456789', 'Connecté', 'OpenFox', 'Plugin Telegram', 'builder', 'Au travail']) assert.ok(text.includes(s), s)
  assert.ok(!text.includes('callout'), 'no warning when all is fine')
})

test('statusPanelContent: warnings for a missing ID, a conflict, a polling error, no conversation', () => {
  assert.match(flatText(statusPanelContent({ tokenSet: true, authorizedUserId: null, connection: 'ok', chats: [] })), /ne répond à personne/)
  assert.match(flatText(statusPanelContent({ tokenSet: true, authorizedUserId: 1, connection: 'conflict', chats: [] })), /autre programme/)
  const err = flatText(statusPanelContent({ tokenSet: true, authorizedUserId: 1, connection: 'error', lastError: 'ETIMEDOUT', chats: [] }))
  assert.match(err, /ETIMEDOUT/)
  assert.match(flatText(statusPanelContent({ tokenSet: true, authorizedUserId: 1, connection: 'ok', chats: [] })), /Aucune conversation/)
})

test('runtime.status reports the connection and each chat session', async () => {
  const telegram = fakeTelegram()
  telegram.getMe = async () => ({ username: 'mon_bot' })
  const storage = { get: (k) => (k === 'chat:7' ? JSON.stringify({ projectId: 'p1', sessionId: 's1' }) : undefined), set() {} }
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 }, storage })
  assert.equal(r.status().connection, 'starting')
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/status' } })
  const ok = await until(() => r.status().connection === 'ok' && r.status().chats.some((c) => c.chatId === 7))
  const s = r.status()
  r.stop()
  assert.ok(ok, JSON.stringify(s))
  assert.equal(s.bot, 'mon_bot')
  assert.deepEqual(s.chats.find((c) => c.chatId === 7), { chatId: 7, projectId: 'p1', sessionId: 's1', running: false })
})

test('package.json: Telegram icon and the ui and rpc capabilities', async () => {
  const { readFileSync } = await import('node:fs')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.openfox.icon, /^data:image\/svg\+xml;base64,/)
  for (const c of ['settings', 'ui', 'rpc']) assert.ok(pkg.openfox.capabilities.includes(c), c)
})

test('runtime.status: connected as soon as the bot answers, and the saved chat shows after a restart', async () => {
  const telegram = fakeTelegram()
  telegram.getMe = async () => ({ username: 'mon_bot' })
  telegram.getUpdates = () => new Promise(() => {}) // a long poll that has not returned yet
  const storage = { get: (k) => (k === 'chat:1' ? JSON.stringify({ projectId: 'p1', sessionId: 's1' }) : undefined), set() {} }
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 }, storage })
  r.start()
  const ok = await until(() => r.status().connection === 'ok')
  const s = r.status()
  r.stop()
  assert.ok(ok, JSON.stringify(s))
  // A private chat's id is the user's id: the authorized user's chat is known.
  assert.deepEqual(s.chats, [{ chatId: 1, projectId: 'p1', sessionId: 's1', running: false }])
})

// ---------------------------------------------------------------------------
// OpenFox's address: the plugin runs inside the server it talks to.
// ---------------------------------------------------------------------------

test('resolveBaseUrl: setting, then --port, then OPENFOX_PORT, then config.json, then 10369', () => {
  const base = { argv: ['node', 'cli.js'], env: {}, configPort: null, override: '' }
  assert.equal(resolveBaseUrl(base), 'http://127.0.0.1:10369')
  assert.equal(resolveBaseUrl({ ...base, configPort: 10370 }), 'http://127.0.0.1:10370')
  assert.equal(resolveBaseUrl({ ...base, configPort: 10370, env: { OPENFOX_PORT: '10400' } }), 'http://127.0.0.1:10400')
  assert.equal(resolveBaseUrl({ ...base, configPort: 10370, env: { OPENFOX_PORT: '10400' }, argv: ['node', 'cli.js', '--port', '10369', '--no-browser'] }), 'http://127.0.0.1:10369')
  assert.equal(resolveBaseUrl({ ...base, argv: ['node', 'cli.js', '--port=10371'] }), 'http://127.0.0.1:10371')
  assert.equal(resolveBaseUrl({ ...base, argv: ['node', 'cli.js', '--port', '10369'], override: 'http://192.168.1.5:10369/' }), 'http://192.168.1.5:10369')
})

test('register: an OpenFox URL setting, optional', () => {
  const r = fakeRegistry({})
  register(r.registry)
  const field = r.settingsCalls[0].fields.find((f) => f.key === 'openfoxUrl')
  assert.ok(field)
  assert.match(field.description.fr, /automatique/)
})

// ---------------------------------------------------------------------------
// The WebSocket subscription forwards the events the bot uses.
// ---------------------------------------------------------------------------

function fakeWebSocketClass() {
  const sockets = []
  class FakeWS {
    constructor(url) {
      this.url = url
      this.listeners = {}
      this.sent = []
      sockets.push(this)
    }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this._emit('close', {}) }
    _emit(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev) }
  }
  return { FakeWS, sockets }
}

test('createWsSubscribe forwards agent questions (chat.ask_user) but never reasoning', () => {
  const { FakeWS, sockets } = fakeWebSocketClass()
  const original = globalThis.WebSocket
  globalThis.WebSocket = FakeWS
  try {
    const got = []
    const subscribe = createWsSubscribe('http://127.0.0.1:10369', noopLogger)
    subscribe('s1', (m) => got.push(m.type))
    const ws = sockets[0]
    ws._emit('open', {})
    assert.deepEqual(ws.sent[0], { id: 'load', type: 'session.load', payload: { sessionId: 's1' } })
    for (const type of ['chat.ask_user', 'chat.thinking', 'chat.done']) ws._emit('message', { data: JSON.stringify({ type, payload: {} }) })
    assert.deepEqual(got, ['chat.ask_user', 'chat.done'])
  } finally {
    globalThis.WebSocket = original
  }
})

// ---------------------------------------------------------------------------
// Files changed by a turn, summed up after its answer.
// ---------------------------------------------------------------------------

test('FileChanges counts the lines written and replaced by successful edits only', () => {
  const c = new FileChanges()
  c.onToolCall('a', 'edit_file', { path: 'src/a.ts', old_string: 'x\ny', new_string: 'x\ny\nz\nw' })
  c.onToolResult('a', true)
  c.onToolCall('b', 'write_file', { path: 'README.md', content: 'l1\nl2\nl3\n' })
  c.onToolResult('b', true)
  c.onToolCall('c', 'edit_file', { path: 'src/a.ts', old_string: 'q', new_string: 'r' })
  c.onToolResult('c', true)
  c.onToolCall('d', 'edit_file', { path: 'fail.ts', old_string: 'a', new_string: 'b' })
  c.onToolResult('d', false)
  c.onToolCall('e', 'read_file', { path: 'x' })
  c.onToolResult('e', true)
  assert.deepEqual(c.files(), [
    { path: 'src/a.ts', added: 5, removed: 3 },
    { path: 'README.md', added: 3, removed: 0 },
  ])
  const html = c.summaryHtml('fr')
  assert.equal(html, '📝 2 fichiers modifiés (+8 −3)\n<blockquote expandable>src/a.ts  +5 −3\nREADME.md  +3 −0</blockquote>')
  assert.equal(new FileChanges().summaryHtml('fr'), null)
  const one = new FileChanges()
  one.onToolCall('a', 'write_file', { path: 'a<b>.md', content: 'x' })
  one.onToolResult('a', true)
  assert.equal(one.summaryHtml('en'), '📝 1 file changed (+1 −0)\n<blockquote expandable>a&lt;b&gt;.md  +1 −0</blockquote>')
})

test('a turn that changed files ends with their summary, after the answer', async () => {
  const telegram = progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  const ev = registered[0].onEvent
  ev({ type: 'chat.tool_call', payload: { callId: 'c1', tool: 'edit_file', args: { path: 'a.ts', old_string: 'a', new_string: 'b\nc' } } })
  ev({ type: 'chat.tool_result', payload: { callId: 'c1', result: { success: true } } })
  ev({ type: 'chat.delta', payload: { messageId: 'm', content: 'Fait.' } })
  ev({ type: 'chat.done', payload: { messageId: 'm', reason: 'complete' } })
  await turn
  await sleep(10)
  const texts = telegram.sent.map((m) => m.text)
  const answer = texts.indexOf('Fait.')
  const summary = texts.findIndex((t) => t.startsWith('📝 1 fichier modifié (+2 −1)'))
  assert.ok(answer >= 0 && summary > answer, JSON.stringify(texts))
  assert.equal(telegram.sent[summary].extra?.parse_mode, 'HTML')
})

// ---------------------------------------------------------------------------
// A very long answer comes as a .md file.
// ---------------------------------------------------------------------------

test('a very long answer is sent as a markdown file with a short caption', async () => {
  const telegram = fakeTelegram()
  const docs = []
  telegram.sendDocument = async (chatId, filename, content, caption) => { docs.push({ filename, content, caption }) }
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv._ensureLocale()
  const long = '# Titre\n\n' + 'Une phrase assez longue. '.repeat(400)
  await conv.sendFormatted(long)
  assert.equal(docs.length, 1)
  assert.equal(docs[0].filename, 'reponse.md')
  assert.equal(docs[0].content, long)
  assert.match(docs[0].caption, /Réponse longue/)
  assert.equal(telegram.sent.length, 0)
  await conv.sendFormatted('court')
  assert.equal(telegram.sent.at(-1).text, 'court')
})

test('a long answer falls back to messages when the file cannot be sent', async () => {
  const telegram = fakeTelegram()
  telegram.sendDocument = async () => { throw new Error('Telegram 400') }
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.sendFormatted('x'.repeat(8000))
  assert.ok(telegram.sent.length >= 2)
})

test('TelegramClient.sendDocument uploads the text as a file', async () => {
  const calls = []
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { status: 200, async json() { return { ok: true, result: { message_id: 9 } } } } }
  const tg = new TelegramClient({ token: '1:a', fetchImpl })
  await tg.sendDocument(7, 'reponse.md', '# Bonjour', 'légende')
  assert.ok(calls[0].url.endsWith('/sendDocument'))
  const form = calls[0].init.body
  assert.ok(form instanceof FormData)
  assert.equal(form.get('chat_id'), '7')
  assert.equal(form.get('caption'), 'légende')
  const file = form.get('document')
  assert.equal(file.name, 'reponse.md')
  assert.equal(await file.text(), '# Bonjour')
})

// ---------------------------------------------------------------------------
// Follow mode: turns started from OpenFox (the web UI) reach Telegram too.
// ---------------------------------------------------------------------------

function multiSubscribe() {
  const subs = []
  const subscribe = (sessionId, onEvent, opts = {}) => {
    const sub = { sessionId, onEvent, onClose: opts.onClose, open: true }
    subs.push(sub)
    return () => { sub.open = false }
  }
  const open = () => subs.filter((s) => s.open)
  return { subscribe, subs, open }
}

function followConv({ follow = true, rest = {}, telegram = progressTelegram() } = {}) {
  const ms = multiSubscribe()
  const conv = new Conversation({
    chatId: 1,
    telegram,
    rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} }, ...rest },
    logger: noopLogger,
    subscribe: ms.subscribe,
    follow: typeof follow === 'function' ? follow : () => follow,
  })
  conv._locale = 'fr'
  conv.state.sessionId = 's1'
  conv.state.stage = 'active'
  return { conv, telegram, ...ms }
}

test('follow: a turn started from OpenFox sends its answer and changed files to Telegram', async () => {
  const { conv, telegram, open } = followConv()
  conv.syncWatcher()
  assert.equal(open().length, 1)
  assert.equal(open()[0].sessionId, 's1')
  const ev = open()[0].onEvent
  ev({ type: 'chat.tool_call', payload: { callId: 'w1', tool: 'write_file', args: { path: 'a.md', content: 'x\ny' } } })
  ev({ type: 'chat.tool_result', payload: { callId: 'w1', result: { success: true } } })
  ev({ type: 'chat.delta', payload: { messageId: 'web1', content: 'Terminé depuis le web.' } })
  ev({ type: 'chat.done', payload: { messageId: 'web1', reason: 'complete' } })
  await sleep(10)
  const texts = telegram.sent.map((m) => m.text)
  assert.ok(texts.some((t) => t.includes('💻') && t.includes('Terminé depuis le web.')), JSON.stringify(texts))
  assert.ok(texts.some((t) => t.startsWith('📝 1 fichier modifié (+2 −0)')))
})

test('follow: off by default, toggled live, closed when turned off', () => {
  let on = false
  const { conv, open } = followConv({ follow: () => on })
  conv.syncWatcher()
  assert.equal(open().length, 0)
  on = true
  conv.syncWatcher()
  assert.equal(open().length, 1)
  conv.syncWatcher()
  assert.equal(open().length, 1, 'one watcher per session')
  on = false
  conv.syncWatcher()
  assert.equal(open().length, 0)
  const plain = new Conversation({ chatId: 1, telegram: fakeTelegram(), rest: {}, logger: noopLogger, subscribe: multiSubscribe().subscribe })
  plain.state.sessionId = 's1'
  plain.syncWatcher()
  assert.equal(plain._watcher, null, 'follow is off without the setting')
})

test('follow: a permission request and a question from an OpenFox turn can be answered on Telegram', async () => {
  const confirms = []
  const answers = []
  const { conv, telegram, open } = followConv({
    rest: {
      async confirmPath(sessionId, callId, approved, always) { confirms.push({ sessionId, callId, approved, always }); return { success: true } },
      async answerQuestion(sessionId, callId, answer) { answers.push({ sessionId, callId, answer }); return {} },
    },
  })
  conv.syncWatcher()
  const ev = open()[0].onEvent
  ev({ type: 'chat.path_confirmation', payload: { callId: 'p1', tool: 'run_command', paths: ['/etc'], reason: 'outside_workdir' } })
  await sleep(5)
  assert.ok(telegram.sent.at(-1).extra?.reply_markup?.inline_keyboard.flat().some((b) => b.callback_data === 'path_confirm:p1:allow'))
  await conv.handleCallback('path_confirm:p1:allow')
  assert.equal(confirms[0]?.sessionId, 's1')
  ev({ type: 'chat.ask_user', payload: { callId: 'q1', question: 'Quel nom ?', type: 'text' } })
  await sleep(5)
  assert.ok(telegram.sent.some((m) => m.text.includes('Quel nom ?')))
  await conv.handleText('Bob')
  assert.deepEqual(answers, [{ sessionId: 's1', callId: 'q1', answer: 'Bob' }])
})

test('follow: a turn started from Telegram is not sent twice', async () => {
  const { conv, telegram, open } = followConv()
  conv.syncWatcher()
  const turn = conv.handleText('salut')
  await sleep(5)
  const [watcher, turnSub] = open()
  assert.ok(turnSub, 'the turn has its own subscription')
  for (const sub of [watcher, turnSub]) sub.onEvent({ type: 'chat.delta', payload: { messageId: 'tg1', content: 'Bonjour !' } })
  turnSub.onEvent({ type: 'chat.done', payload: { messageId: 'tg1', reason: 'complete' } })
  await turn
  // The watcher's socket delivers the same end after the turn is over.
  watcher.onEvent({ type: 'chat.done', payload: { messageId: 'tg1', reason: 'complete' } })
  await sleep(10)
  assert.equal(telegram.sent.filter((m) => m.text.includes('Bonjour !')).length, 1)
})

test('follow: the watcher moves with the active session and reconnects after a drop', () => {
  const { conv, open, subs } = followConv()
  conv.syncWatcher()
  conv.state.sessionId = 's2'
  conv.syncWatcher()
  assert.deepEqual(open().map((s) => s.sessionId), ['s2'])
  subs.at(-1).onClose?.()
  conv.syncWatcher()
  assert.equal(open().filter((s) => s.sessionId === 's2').length, 1)
  assert.equal(subs.length, 3, 'a new subscription after the drop')
  conv.state.sessionId = null
  conv.syncWatcher()
  assert.equal(open().length, 0)
})

test('follow: the setting is registered, off by default', () => {
  const r = fakeRegistry({})
  register(r.registry)
  const field = r.settingsCalls[0].fields.find((f) => f.key === 'followSession')
  assert.equal(field.type, 'boolean')
  assert.equal(field.default, false)
  assert.ok(field.label.fr && field.description.fr && field.description.en)
})

test('runtime: with follow on, the saved session is watched from the start', async () => {
  const telegram = fakeTelegram()
  const ms = multiSubscribe()
  const storage = { get: (k) => (k === 'chat:1' ? JSON.stringify({ projectId: 'p', sessionId: 's1' }) : undefined), set() {} }
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe: ms.subscribe, logger: noopLogger, auth: { userId: 1 }, storage, follow: () => true })
  r.start()
  const ok = await until(() => ms.open().some((s) => s.sessionId === 's1'))
  r.stop()
  assert.ok(ok)
  assert.equal(ms.open().length, 0, 'closed on stop')
})

test('follow: path confirmation buttons are removed when the OpenFox turn ends', async () => {
  const { conv, telegram, open } = followConv()
  conv.syncWatcher()
  const ev = open()[0].onEvent
  ev({ type: 'chat.path_confirmation', payload: { callId: 'p1', tool: 'run_command', paths: ['/etc'], reason: 'outside_workdir' } })
  await new Promise((r) => setImmediate(r))
  ev({ type: 'chat.delta', payload: { messageId: 'w1', content: 'Fait.' } })
  ev({ type: 'chat.done', payload: { messageId: 'w1', reason: 'complete' } })
  await sleep(10)
  const edits = telegram.edits.filter((e) => e.markup !== undefined)
  assert.equal(edits.length, 1, JSON.stringify(telegram.edits))
  assert.deepEqual(edits[0].markup, { inline_keyboard: [] })
  assert.equal(conv.state.pendingPathConfirms.size, 0)
})

test('follow: a message sent while an OpenFox turn runs is queued, and both answers come through the watcher', async () => {
  const sent = []
  const { conv, telegram, open } = followConv({ rest: { async sendMessage(sessionId, content) { sent.push(content); return {} } } })
  conv.syncWatcher()
  const watcher = open()[0]
  watcher.onEvent({ type: 'chat.delta', payload: { messageId: 'web1', content: 'Réponse web' } })
  await conv.handleText('et ensuite ?')
  assert.deepEqual(sent, ['et ensuite ?'])
  assert.ok(telegram.sent.at(-1).text.includes('file'), 'told it is queued')
  assert.equal(open().length, 1, 'no Telegram turn started')
  watcher.onEvent({ type: 'chat.done', payload: { messageId: 'web1', reason: 'complete' } })
  watcher.onEvent({ type: 'chat.delta', payload: { messageId: 'web2', content: 'Réponse à ta question' } })
  watcher.onEvent({ type: 'chat.done', payload: { messageId: 'web2', reason: 'complete' } })
  await sleep(10)
  const texts = telegram.sent.map((m) => m.text).join('\n')
  assert.ok(texts.includes('Réponse web') && texts.includes('Réponse à ta question'), texts)
})

// ---------------------------------------------------------------------------
// Review fixes.
// ---------------------------------------------------------------------------

test('two questions in a row: each button answers its own question', async () => {
  const { conv, telegram, answers, registered } = questionConv()
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  const ev = registered[0].onEvent
  ev({ type: 'chat.ask_user', payload: { callId: 'qa', question: 'Langage ?', type: 'choice', options: [{ value: 'ts', label: 'TS' }, { value: 'py', label: 'Python' }] } })
  const first = telegram.sent.at(-1).extra.reply_markup.inline_keyboard.flat()
  ev({ type: 'chat.ask_user', payload: { callId: 'qb', question: 'Base ?', type: 'choice', options: [{ value: 'pg', label: 'Postgres' }, { value: 'sqlite', label: 'SQLite' }] } })
  const second = telegram.sent.at(-1).extra.reply_markup.inline_keyboard.flat()
  for (const b of [...first, ...second]) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data)
  await conv.handleCallback(first[1].callback_data)
  assert.deepEqual(answers, [{ sessionId: 's1', callId: 'qa', answer: 'py' }])
  assert.ok(conv.hasPendingQuestion(), 'the second question still waits')
  await conv.handleCallback(first[0].callback_data)
  assert.equal(answers.length, 1, 'an answered question cannot be answered again')
  await conv.handleText('sqlite')
  assert.deepEqual(answers[1], { sessionId: 's1', callId: 'qb', answer: 'sqlite' })
  assert.ok(!conv.hasPendingQuestion())
  conv.stopTurn()
  await turn
})

test('a typed message answers the last question asked', async () => {
  const { conv, answers, registered } = questionConv()
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.ask_user', payload: { callId: 'q1', question: 'A ?', type: 'text' } })
  registered[0].onEvent({ type: 'chat.ask_user', payload: { callId: 'q2', question: 'B ?', type: 'text' } })
  await conv.handleText('réponse B')
  await conv.handleText('réponse A')
  assert.deepEqual(answers.map((a) => [a.callId, a.answer]), [['q2', 'réponse B'], ['q1', 'réponse A']])
  conv.stopTurn()
  await turn
})

test('a turn whose end arrives while subscribing finishes cleanly', async () => {
  const telegram = fakeTelegram()
  const subscribe = (sessionId, onEvent) => {
    onEvent({ type: 'chat.delta', payload: { messageId: 'm', content: 'déjà fini' } })
    onEvent({ type: 'chat.done', payload: { messageId: 'm', reason: 'complete' } })
    return () => {}
  }
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  await conv.runTurn('s1', 'go')
  await sleep(5)
  assert.ok(telegram.sent.some((m) => m.text === 'déjà fini'))
})

test('/status says the session could not be read when OpenFox fails', async () => {
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async getSessionDetail() { throw new Error('OpenFox 500: boom') } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.sessionId = 's1'
  await conv.handleText('/status')
  assert.equal(telegram.sent.at(-1).text, "⚠️ Impossible de lire l'état de la session : OpenFox 500: boom")
})

test('configFilePort reads the port of the config directory that holds the plugins', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'tg-port-'))
  try {
    const local = join(root, 'plugins', 'openfox-telegram', 'src')
    const npm = join(root, 'plugins', 'node_modules', 'openfox-telegram', 'src')
    mkdirSync(local, { recursive: true })
    mkdirSync(npm, { recursive: true })
    assert.equal(configFilePort(local), null, 'no config.json')
    writeFileSync(join(root, 'config.json'), JSON.stringify({ server: { port: 10370 } }))
    assert.equal(configFilePort(local), 10370)
    assert.equal(configFilePort(npm), 10370)
    writeFileSync(join(root, 'config.json'), '{ broken')
    assert.equal(configFilePort(local), null)
    assert.equal(configFilePort(join(root, 'elsewhere')), null, 'not inside a plugins directory')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Every message of the agent reaches Telegram, not only the last one.
// ---------------------------------------------------------------------------

const ended = (messageId) => ({ type: 'chat.message_updated', payload: { messageId, updates: { isStreaming: false } } })

test('the agent messages of a turn are all sent, in order, each once', async () => {
  const telegram = progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  const ev = registered[0].onEvent
  ev({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Je regarde le code.' } })
  ev(ended('m1'))
  ev({ type: 'chat.tool_call', payload: { callId: 'c1', tool: 'read_file', args: { path: 'a.ts' } } })
  ev({ type: 'chat.tool_result', payload: { callId: 'c1', result: { success: true } } })
  await sleep(5)
  ev({ type: 'chat.delta', payload: { messageId: 'm2', content: 'Fini.' } })
  ev(ended('m2'))
  ev({ type: 'chat.done', payload: { messageId: 'm2', reason: 'complete' } })
  await turn
  const texts = telegram.sent.map((m) => m.text)
  assert.equal(texts.filter((t) => t === 'Je regarde le code.').length, 1, JSON.stringify(texts))
  assert.equal(texts.filter((t) => t === 'Fini.').length, 1, JSON.stringify(texts))
  const first = texts.indexOf('Je regarde le code.')
  const progress = texts.findIndex((t) => t.includes('read_file'))
  assert.ok(first < progress && progress < texts.indexOf('Fini.'), JSON.stringify(texts))
})

test('the last message is sent on chat.done even without its end event', async () => {
  const telegram = progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  registered[0].onEvent({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Réponse.' } })
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await turn
  assert.equal(telegram.sent.filter((m) => m.text === 'Réponse.').length, 1)
})

test('tools after an agent message go into a new progress message', async () => {
  const telegram = progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  const ev = registered[0].onEvent
  ev({ type: 'chat.tool_call', payload: { callId: 'c1', tool: 'read_file', args: { path: 'a.ts' } } })
  await sleep(5)
  ev({ type: 'chat.delta', payload: { messageId: 'm1', content: 'Étape 1 faite.' } })
  ev(ended('m1'))
  ev({ type: 'chat.tool_call', payload: { callId: 'c2', tool: 'read_file', args: { path: 'b.ts' } } })
  await sleep(10)
  ev({ type: 'chat.done', payload: { messageId: 'm1', reason: 'complete' } })
  await turn
  const texts = telegram.sent.map((m) => m.text)
  const a = texts.findIndex((t) => t.includes('a.ts'))
  const b = texts.findIndex((t) => t.includes('b.ts'))
  assert.ok(a >= 0 && b > texts.indexOf('Étape 1 faite.'), JSON.stringify(texts))
  assert.ok(!texts[b].includes('a.ts'), 'the new progress message only holds the new steps')
  assert.ok(!telegram.edits.some((e) => e.text.includes('b.ts') && e.text.includes('a.ts')), 'the first progress message is not edited with later steps')
})

test('createWsSubscribe forwards the end of each agent message', () => {
  const { FakeWS, sockets } = fakeWebSocketClass()
  const original = globalThis.WebSocket
  globalThis.WebSocket = FakeWS
  try {
    const got = []
    createWsSubscribe('http://127.0.0.1:10369', noopLogger)('s1', (m) => got.push(m.type))
    sockets[0]._emit('message', { data: JSON.stringify({ type: 'chat.message_updated', payload: { messageId: 'm', updates: { isStreaming: false } } }) })
    assert.deepEqual(got, ['chat.message_updated'])
  } finally {
    globalThis.WebSocket = original
  }
})

test('follow: every agent message of an OpenFox turn is sent, the header only on the first', async () => {
  const { conv, telegram, open } = followConv()
  conv.syncWatcher()
  const ev = open()[0].onEvent
  ev({ type: 'chat.delta', payload: { messageId: 'w1', content: 'Je commence.' } })
  ev(ended('w1'))
  ev({ type: 'chat.delta', payload: { messageId: 'w2', content: 'Terminé.' } })
  ev(ended('w2'))
  ev({ type: 'chat.done', payload: { messageId: 'w2', reason: 'complete' } })
  await sleep(20)
  const texts = telegram.sent.map((m) => m.text)
  const a = texts.findIndex((t) => t.includes('Je commence.'))
  const b = texts.findIndex((t) => t.includes('Terminé.'))
  assert.ok(a >= 0 && b > a, JSON.stringify(texts))
  assert.ok(texts[a].includes('💻'))
  assert.ok(!texts[b].includes('💻'))
  assert.equal(texts.filter((t) => t.includes('Terminé.')).length, 1)
})

// ---------------------------------------------------------------------------
// The "📂 Projets" header goes away with the list; history layout.
// ---------------------------------------------------------------------------

function numberedTelegram() {
  const t = progressTelegram()
  t.deleted = []
  t.deleteMessage = async (chatId, messageId) => { t.deleted.push(messageId) }
  return t
}

test('the "📂 Projets" message is deleted right away, its keys stay', async () => {
  const telegram = numberedTelegram()
  const rest = { async getLocale() { return 'fr' }, async listProjects() { return [{ id: 'p1', name: 'P1' }] } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText(KEYS.start)
  const i = telegram.sent.findIndex((m) => m.text === '📂 Projets')
  assert.deepEqual(telegram.sent[i].extra?.reply_markup?.keyboard, [[KEYS.start]], 'it brings the keys down to start')
  assert.deepEqual(telegram.deleted, [100 + i], 'deleted at once')
})

test('choosing a project deletes the project list', async () => {
  const telegram = numberedTelegram()
  const rest = { async getLocale() { return 'fr' }, async listProjects() { return [{ id: 'p1', name: 'P1' }] }, async listSessions() { return [] } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText(KEYS.start)
  const listId = 100 + telegram.sent.findIndex((m) => m.text === 'Choisissez un projet :')
  await conv.handleCallback('proj:p1')
  assert.ok(telegram.deleted.includes(listId), JSON.stringify(telegram.deleted))
})

test('a new start deletes the project list a previous start left in the chat', async () => {
  const telegram = numberedTelegram()
  const rest = { async getLocale() { return 'fr' }, async listProjects() { return [{ id: 'p1', name: 'P1' }] } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText(KEYS.start)
  const oldList = 100 + telegram.sent.findIndex((m) => m.text === 'Choisissez un projet :')
  await conv.handleText(KEYS.start)
  assert.ok(telegram.deleted.includes(oldList), JSON.stringify(telegram.deleted))
})

test('the history starts on its own line after "📜 Historique :"', async () => {
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async getSessionDetail() { return { session: {}, messages: [{ role: 'user', content: 'bonjour' }] } } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.sessionId = 's1'
  await conv.showSessionActive('S1')
  assert.ok(telegram.sent.at(-1).text.includes('📜 Historique :\n\n👤 Vous : bonjour'), telegram.sent.at(-1).text)
})

// ---------------------------------------------------------------------------
// Full review fixes.
// ---------------------------------------------------------------------------

test('the "/" menu is set at start, in French and in English, with the commands without a key too', async () => {
  const telegram = fakeTelegram()
  const calls = []
  telegram.setMyCommands = async (commands, opts = {}) => { calls.push({ commands, lang: opts.languageCode ?? null }) }
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe: fakeSubscribe().subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  await sleep(20)
  r.stop()
  assert.ok(!calls.some((c) => c.commands.length === 0), 'never cleared')
  const fr = calls.find((c) => c.lang === null)
  const en = calls.find((c) => c.lang === 'en')
  const names = ['start', 'stop', 'agents', 'status', 'model', 'sessions', 'new', 'new_session']
  assert.deepEqual(fr.commands.map((c) => c.command), names)
  assert.deepEqual(en.commands.map((c) => c.command), names)
  for (const c of [...fr.commands, ...en.commands]) assert.match(c.command, /^[a-z0-9_]{1,32}$/)
  assert.notEqual(fr.commands[0].description, en.commands[0].description)
})

test('/new without a name asks for it', async () => {
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/new')
  assert.equal(conv.state.stage, 'new_project_name')
  assert.equal(telegram.sent.at(-1).text, 'Envoyez le nom du nouveau projet.')
})

test('/continue keeps the whole session id', async () => {
  const conv = new Conversation({ chatId: 1, telegram: fakeTelegram(), rest: { async getLocale() { return 'fr' } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  await conv.handleText('/continue abc123')
  assert.equal(conv.state.sessionId, 'abc123')
})

test('stop stops the active session when the agent works without a Telegram turn', async () => {
  const stopped = []
  const telegram = fakeTelegram()
  const rest = {
    async getLocale() { return 'fr' },
    async getSessionDetail() { return { session: { isRunning: true } } },
    async stopSession(id) { stopped.push(id); return {} },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.sessionId = 's1'
  await conv.handleText(KEYS.stop)
  assert.deepEqual(stopped, ['s1'])
  assert.equal(telegram.sent.at(-1).text, 'Tour arrêté.')
  rest.getSessionDetail = async () => ({ session: { isRunning: false } })
  await conv.handleText(KEYS.stop)
  assert.equal(telegram.sent.at(-1).text, 'Rien à arrêter.')
  assert.deepEqual(stopped, ['s1'])
})

test('a turn ending as truncated or error ends here too', async () => {
  for (const reason of ['truncated', 'error']) {
    const telegram = fakeTelegram()
    const { subscribe, registered } = fakeSubscribe()
    const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
    const turn = conv.runTurn('s1', 'go')
    registered[0].onEvent({ type: 'chat.delta', payload: { messageId: 'm', content: 'Partiel' } })
    registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm', reason } })
    const ended = await Promise.race([turn.then(() => true), sleep(200).then(() => false)])
    assert.ok(ended, `${reason} ends the turn`)
    assert.ok(telegram.sent.some((m) => m.text === 'Partiel'))
  }
})

test('Telegram and OpenFox requests give up after their time limit', async () => {
  const hanging = (url, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason)))
  const tg = new TelegramClient({ token: '1:a', fetchImpl: hanging, requestTimeoutMs: 20 })
  await assert.rejects(tg.sendMessage(1, 'x'))
  const rest = new OpenFoxRestClient({ baseUrl: 'http://x', fetchImpl: hanging, requestTimeoutMs: 20 })
  await assert.rejects(rest.listProjects())
  // The long poll waits longer than its own server-side timeout.
  let pollSignal
  const tg2 = new TelegramClient({ token: '1:a', fetchImpl: async (url, init) => { pollSignal = init.signal; return { status: 200, async json() { return { ok: true, result: [] } } } } })
  await tg2.getUpdates(undefined, 30)
  assert.ok(pollSignal, 'the long poll has a time limit too')
})

test('routine activity is logged at debug level, not info', async () => {
  const infos = []
  const logger = { debug() {}, info: (m) => infos.push(String(m)), warn() {}, error() {} }
  const telegram = fakeTelegram()
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe: fakeSubscribe().subscribe, logger, auth: { userId: 1 } })
  r.start()
  await sleep(80)
  r.stop()
  const conv = new Conversation({ chatId: 1, telegram, rest: {}, logger, subscribe: fakeSubscribe().subscribe })
  await conv._sendTyping('tick')
  assert.ok(!infos.some((m) => /polling for updates|got updates|typing indicator sent/.test(m)), JSON.stringify(infos))
})

test('English: permission request, its results, the turn timeout and the history', async () => {
  const timer = fakeTimer()
  const telegram = fakeTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const rest = {
    async getLocale() { return 'en' },
    async sendMessage() { return {} },
    async confirmPath() { return {} },
    async getSessionDetail() { return { session: {}, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] } },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe, timer })
  await conv._ensureLocale()
  const turn = conv.runTurn('s1', 'go')
  registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'p1', tool: 'run_command', paths: ['/etc'], reason: 'dangerous_command' } })
  const confirm = telegram.sent.at(-1)
  assert.match(confirm.text, /dangerous command/)
  assert.deepEqual(confirm.extra.reply_markup.inline_keyboard.flat().map((b) => b.text), ['Allow', 'Deny', 'Allow everything'])
  await conv.handleCallback('path_confirm:p1:allow')
  assert.equal(telegram.sent.at(-1).text, '✅ Allowed.')
  conv.stopTurn()
  await turn
  conv.state.sessionId = 's1'
  await conv.showSessionActive('S1')
  const h = telegram.sent.at(-1).text
  assert.ok(h.includes('📜 History:\n\n👤 You: hi\n\n🤖 Agent: hello'), h)
})

test('English: the turn timeout message', async () => {
  const timer = fakeTimer()
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'en' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe, timer })
  await conv._ensureLocale()
  const turn = conv.runTurn('s1', 'go')
  timer._fireTimeout(1)
  await turn
  assert.ok(telegram.sent.some((m) => m.text === '⚠️ The turn timed out without an answer. Try again.'), JSON.stringify(telegram.sent.map((m) => m.text)))
})

test('the night mode button does not turn it on when its state cannot be read', async () => {
  const set = []
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async getSessionDetail() { throw new Error('OpenFox 500') }, async setNightMode(id, v) { set.push(v) } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv.state.sessionId = 's1'
  await conv.handleCallback('night:toggle')
  assert.deepEqual(set, [])
  assert.match(telegram.sent.at(-1).text, /⚠️/)
})

test('an answer that fails to reach OpenFox keeps the question for another try', async () => {
  const telegram = fakeTelegram()
  let fail = true
  const answers = []
  const rest = { async getLocale() { return 'fr' }, async answerQuestion(s, c, a) { if (fail) throw new Error('OpenFox 502'); answers.push(a) } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv._showQuestion({ callId: 'q1', question: 'Nom ?', type: 'text' }, 's1')
  await conv.handleText('Bob')
  assert.ok(conv.hasPendingQuestion(), 'still waiting')
  fail = false
  await conv.handleText('Bob')
  assert.deepEqual(answers, ['Bob'])
  assert.ok(!conv.hasPendingQuestion())
})

test('a formatted message never exceeds Telegram length once converted to HTML', async () => {
  const telegram = fakeTelegram()
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  // "&" becomes "&amp;": 3,000 of them are 15,000 characters of HTML.
  await conv.sendFormatted(('a & b < c\n').repeat(300))
  assert.ok(telegram.sent.length > 1)
  for (const m of telegram.sent) {
    assert.equal(m.extra?.parse_mode, 'HTML')
    assert.ok(m.text.length <= 4096, `length ${m.text.length}`)
  }
  assert.equal(telegram.sent.map((m) => m.text).join('').replaceAll('&amp;', '&').replaceAll('&lt;', '<'), ('a & b < c\n').repeat(300))
})

test('a project name follows OpenFox rules: letters, digits, dot, dash, underscore, spaces', async () => {
  const created = []
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async getDefaultWorkdir() { return '/srv' }, async createProject(name, workdir) { created.push(workdir); return { id: 'p' } }, async listSessions() { return [] }, async listProjects() { return [] } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  for (const bad of ['../../tmp/x', 'a/b', 'a\\b', 'pré-projet', '..']) {
    await conv.handleText(`/new ${bad}`)
    assert.match(telegram.sent.at(-1).text, /Nom de projet invalide/, bad)
  }
  assert.deepEqual(created, [])
  await conv.handleText('/new Mon_site-2.0 v1')
  assert.deepEqual(created, ['/srv/Mon_site-2.0 v1'])
})

// ---------------------------------------------------------------------------
// Model picker features
// ---------------------------------------------------------------------------

test('OpenFoxRestClient.setSessionProvider POSTs {providerId, model} to /api/sessions/:id/provider', async () => {
  const calls = []
  const client = new OpenFoxRestClient({
    baseUrl: 'http://x',
    fetchImpl: async (url, opts) => {
      calls.push([String(url), opts])
      return { status: 200, json: async () => ({ session: { id: 's1', providerModel: 'm1' } }) }
    },
  })
  const session = await client.setSessionProvider('s1', 'p1', 'm1')
  assert.deepEqual(session, { id: 's1', providerModel: 'm1' })
  const [url, opts] = calls[0]
  assert.ok(url.endsWith('/api/sessions/s1/provider'))
  assert.equal(opts.method, 'POST')
  assert.deepEqual(JSON.parse(opts.body), { providerId: 'p1', model: 'm1' })
})

test('/status with providerModel shows the model line', async () => {
  const sent = []
  const rest = {
    getSessionDetail: async () => ({ session: { providerModel: 'gpt-4', metadata: { title: 'S1' } } }),
    listProjects: async () => [{ id: 'p1', name: 'A' }],
  }
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest,
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  conv.state.sessionId = 's1'
  conv.state.projectId = 'p1'
  await conv.showStatus()
  assert.ok(sent.at(-1).includes('gpt-4'))
  assert.ok(sent.at(-1).includes('Modèle'))
})

test('/model without session says "Pas de session active"', async () => {
  const sent = []
  const conv = new Conversation({
    chatId: 'c1',
    telegram: { sendMessage: async (c, t) => sent.push(t), sendChatAction: async () => {} },
    rest: { async getLocale() { return 'fr' } },
    subscribe: fakeSubscribe().subscribe,
    logger: noopLogger,
  })
  await conv.handleText('/model')
  assert.ok(sent.at(-1).toLowerCase().includes('session'))
})

test('/model is in BOT_COMMANDS and not in KEYS', () => {
  assert.ok(BOT_COMMANDS.some((c) => c.command === 'model'))
  assert.ok(BOT_COMMANDS_EN.some((c) => c.command === 'model'))
  assert.ok(!('model' in KEYS))
})

test('register called twice does not leave orphan runtimes', () => {
  const r1 = fakeRegistry({ botToken: 'test-token' })
  register(r1.registry)
  const r2 = fakeRegistry({ botToken: 'test-token' })
  register(r2.registry)
  deactivate()
  deactivate()
})

// ---------------------------------------------------------------------------
// Re-import (cache-bust) stops the previous runtime
// ---------------------------------------------------------------------------
//
// OpenFox re-imports a plugin with a cache-bust query string (?v=...), which
// creates a FRESH ESM module instance: the module-scoped `runtime` variable is
// NOT shared across instances. If `register()` only stops the module-scoped
// `runtime`, the previous runtime (with its poll loop and watchers) is never
// stopped → orphaned watchers forward every answer multiple times.
//
// The fix stores the runtime in globalThis[Symbol.for('openfox-telegram-runtime')]
// so a re-import can reach and stop the previous runtime.

test('re-import (cache-bust) stops the previous runtime', { timeout: 5000 }, async (t) => {
  const origFetch = globalThis.fetch
  const origWebSocket = globalThis.WebSocket
  const origPort = process.env.OPENFOX_PORT
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, result: [] }) })
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 1 }
    close() { this.readyState = 3 }
    send() {}
    addEventListener() {}
    removeEventListener() {}
  }
  process.env.OPENFOX_PORT = '10370'

  let modA, modB
  t.after(() => {
    try { modA?.deactivate() } catch {}
    try { modB?.deactivate() } catch {}
    globalThis.fetch = origFetch
    globalThis.WebSocket = origWebSocket
    if (origPort === undefined) delete process.env.OPENFOX_PORT
    else process.env.OPENFOX_PORT = origPort
  })

  // First "server boot": fresh module instance A.
  modA = await importFreshModule()
  modA.register(fakeRegistry({ botToken: 'T1', authorizedUserId: '42' }).registry)

  // The fix stores the runtime in globalThis so a re-import can reach it.
  const runtimeA = globalThis[RUNTIME_KEY]
  assert.ok(runtimeA, 'register should store the runtime in globalThis')

  // Spy on runtimeA.stop to observe whether the second register stops it.
  let stopCalled = false
  const origStop = runtimeA.stop
  runtimeA.stop = function () {
    stopCalled = true
    return origStop.call(this)
  }

  // Second "server boot" (cache-bust re-import): fresh module instance B.
  modB = await importFreshModule()
  modB.register(fakeRegistry({ botToken: 'T1', authorizedUserId: '42' }).registry)

  // The second register must have stopped the first runtime.
  assert.ok(stopCalled, 'the previous runtime must be stopped on re-import')

  // A fresh runtime is created and stored in globalThis (not the old one).
  const runtimeB = globalThis[RUNTIME_KEY]
  assert.ok(runtimeB, 'register should store the new runtime in globalThis')
  assert.notEqual(runtimeB, runtimeA, 'a fresh runtime should be created on re-import')
})

// ---------------------------------------------------------------------------
// Review of v1.0.3: compaction + queue, permission wording and buttons,
// double button removal, log levels.
// ---------------------------------------------------------------------------

function confirmConv({ locale = 'fr', rest = {}, telegram } = {}) {
  const tg = telegram ?? progressTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({
    chatId: 1,
    telegram: tg,
    rest: { async getLocale() { return locale }, async sendMessage() { return {} }, ...rest },
    logger: noopLogger,
    subscribe,
  })
  return { conv, telegram: tg, registered }
}

test('compaction then a queued message: the turn lasts until the answer to that message', async () => {
  const { conv, telegram, registered } = confirmConv()
  const turn = conv.handleText('/send s1 go')
  await sleep(5)
  await conv.queueText('message en file')
  const ev = registered[0].onEvent
  // Compaction first (its own chat.done), then the server injects the queued
  // message (a chat.done for it), then the agent answers it.
  ev({ type: 'chat.message', payload: { message: { id: 'sum', role: 'assistant', content: 'RÉSUMÉ', isCompactionSummary: true } } })
  ev({ type: 'chat.done', payload: { messageId: 'sum', reason: 'complete' } })
  ev({ type: 'chat.done', payload: { messageId: 'asap1', reason: 'complete' } })
  const endedEarly = await Promise.race([turn.then(() => true), sleep(60).then(() => false)])
  assert.equal(endedEarly, false, 'the turn must still be waiting for the answer to the queued message')
  ev({ type: 'chat.delta', payload: { messageId: 'a1', content: 'Réponse au message en file.' } })
  ev({ type: 'chat.message_updated', payload: { messageId: 'a1', updates: { isStreaming: false } } })
  ev({ type: 'chat.done', payload: { messageId: 'a1', reason: 'complete' } })
  await turn
  const texts = telegram.sent.map((m) => m.text)
  assert.ok(texts.includes('Réponse au message en file.'), JSON.stringify(texts))
  assert.ok(!texts.some((t) => t.includes('RÉSUMÉ')))
})

test('permission requests say what is asked, like the web UI', async () => {
  const cases = [
    ['fr', 'outside_workdir', 'accès hors dossier'],
    ['fr', 'sensitive_file', 'fichier sensible'],
    ['fr', 'both', 'fichier sensible hors du projet'],
    ['fr', 'dangerous_command', 'commande dangereuse'],
    ['fr', 'git_no_verify', 'git --no-verify'],
    ['en', 'sensitive_file', 'sensitive file'],
    ['en', 'both', 'sensitive file outside the project'],
    ['en', 'git_no_verify', 'git --no-verify'],
  ]
  for (const [locale, reason, expected] of cases) {
    const { conv, telegram, registered } = confirmConv({ locale })
    await conv._ensureLocale()
    const turn = conv.runTurn('s1', 'go')
    registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'p1', tool: 'run_command', paths: ['/x'], reason } })
    await sleep(5)
    const sent = telegram.sent.find((m) => m.text.includes('🔒'))
    assert.ok(sent.text.includes(expected), `${locale}/${reason}: ${sent.text}`)
    conv.stopTurn()
    await turn
  }
})

test('the "allow everything" button is named like the web UI and hidden for git --no-verify', async () => {
  for (const [locale, label] of [['fr', 'Tout autoriser'], ['en', 'Allow everything']]) {
    const { conv, telegram, registered } = confirmConv({ locale })
    await conv._ensureLocale()
    const turn = conv.runTurn('s1', 'go')
    registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'p1', tool: 'run_command', paths: ['/x'], reason: 'outside_workdir' } })
    registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'p2', tool: 'run_command', paths: ['git commit --no-verify'], reason: 'git_no_verify' } })
    await sleep(10)
    const buttons = (id) => telegram.sent.find((m) => m.extra?.reply_markup?.inline_keyboard?.flat().some((b) => b.callback_data.includes(`:${id}:`))).extra.reply_markup.inline_keyboard.flat()
    assert.ok(buttons('p1').some((b) => b.text === label && b.callback_data === 'path_confirm:p1:always'), `${locale}: ${JSON.stringify(buttons('p1'))}`)
    assert.ok(!buttons('p2').some((b) => b.callback_data.endsWith(':always')), 'no blanket button for git --no-verify')
    assert.equal(buttons('p2').length, 2)
    conv.stopTurn()
    await turn
  }
})

test('"allow everything" switches the session to dangerous mode like the web UI, with a fallback to allow once', async () => {
  const calls = []
  let failSwitch = false
  const { conv, telegram, registered } = confirmConv({
    rest: {
      async confirmPath(...a) { calls.push(['confirmPath', ...a]); return {} },
      async setDangerLevel(...a) { calls.push(['setDangerLevel', ...a]); if (failSwitch) throw new Error('boom'); return {} },
    },
  })
  const turn = conv.runTurn('s1', 'go')
  registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'p1', tool: 'run_command', paths: ['/x'], reason: 'outside_workdir' } })
  await sleep(5)
  await conv.handleCallback('path_confirm:p1:always')
  assert.deepEqual(calls, [['setDangerLevel', 's1', 'dangerous']], 'the switch resolves the pending request on the server')
  assert.equal(telegram.sent.at(-1).text, '✅ Mode dangereux activé : tout est autorisé pour cette session.')

  calls.length = 0
  failSwitch = true
  registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'p2', tool: 'run_command', paths: ['/y'], reason: 'outside_workdir' } })
  await sleep(5)
  await conv.handleCallback('path_confirm:p2:always')
  assert.deepEqual(calls, [['setDangerLevel', 's1', 'dangerous'], ['confirmPath', 's1', 'p2', true, false]])
  assert.match(telegram.sent.at(-1).text, /mode dangereux/i)
  conv.stopTurn()
  await turn
})

test('a permission click removes the buttons once, not twice', async () => {
  const telegram = progressTelegram()
  const edits = []
  telegram.editMessageReplyMarkup = async (chatId, messageId) => { edits.push(messageId) }
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest: runtimeRest(), subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 go' } })
  assert.ok(await until(() => registered.length > 0))
  registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'p1', tool: 'run_command', paths: ['/x'], reason: 'outside_workdir' } })
  assert.ok(await until(() => telegram.sent.some((m) => m.text.includes('🔒'))))
  const messageId = 100 + telegram.sent.findIndex((m) => m.text.includes('🔒'))
  telegram._push({ update_id: 2, callback_query: { id: 'cb', from: { id: 1 }, message: { message_id: messageId, chat: { id: 7 } }, data: 'path_confirm:p1:allow' } })
  assert.ok(await until(() => edits.length > 0))
  await sleep(60)
  r.stop()
  assert.deepEqual(edits, [messageId])
})

test('routine confirmation and turn bookkeeping is logged at debug level, not info', async () => {
  const infos = []
  const logger = { debug() {}, info: (m) => infos.push(String(m)), warn() {}, error() {} }
  const { subscribe, registered } = fakeSubscribe()
  const conv = new Conversation({ chatId: 1, telegram: progressTelegram(), rest: { async getLocale() { return 'fr' }, async sendMessage() { return {}; }, async confirmPath() { return {} } }, logger, subscribe })
  const turn = conv.runTurn('s1', 'go')
  registered[0].onEvent({ type: 'chat.path_confirmation', payload: { callId: 'p1', tool: 'run_command', paths: ['/x'], reason: 'outside_workdir' } })
  await sleep(5)
  await conv.handleCallback('path_confirm:p1:allow')
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'sub', reason: 'complete', agentType: 'sub-agent' } })
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'w', reason: 'waiting_for_user' } })
  conv.stopTurn()
  await turn
  assert.deepEqual(infos.filter((m) => /_showPathConfirmation|path_confirm callback|confirmPath result|buttons removed|no finish|removing path confirmation/.test(m)), [])
})

// ---------------------------------------------------------------------------
// /model on the real API shape: GET /api/providers returns
// { providers: [{ id, name, models: [{ id, ... }] }], activeProviderId }.
// ---------------------------------------------------------------------------

const P_LLAMA = '570e0009-0838-42ff-919a-c037fc25a82f'
const P_ORCA = '6366b9d5-2ad3-4ec5-b09c-88ae886d0591'
const P_OPENR = '0fd5f170-a414-4cf1-9694-692ff58f2745'
const GGUF = 'C:\\ProgramData\\ajean\\models\\Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf'
const OPENR_MODELS = ['anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-5.5:batch', ...Array.from({ length: 28 }, (_, i) => `vendor-${i}/model-${i}-instruct`)]

function providersFixture() {
  return {
    providers: [
      { id: P_LLAMA, name: 'llamacpp', models: [{ id: GGUF, contextWindow: 80000 }] },
      { id: P_ORCA, name: 'OrcaRouter', models: [{ id: 'orcarouter/free' }, { id: 'orcarouter/fusion' }] },
      { id: P_OPENR, name: 'OpenRouter', models: OPENR_MODELS.map((id) => ({ id, contextWindow: 128000 })) },
    ],
    activeProviderId: P_ORCA,
  }
}

function modelConv({ providers = providersFixture(), session = { id: 's1', providerId: P_LLAMA, providerModel: GGUF, metadata: { title: 'Ma session' } }, rest = {} } = {}) {
  const telegram = progressTelegram()
  telegram.deleted = []
  telegram.deleteMessage = async (c, id) => { telegram.deleted.push(id) }
  const calls = []
  const conv = new Conversation({
    chatId: 1,
    telegram,
    rest: {
      async getLocale() { return 'fr' },
      async listProviders() { return providers },
      async getSessionDetail(id) { return { session: { ...session, id } } },
      async setSessionProvider(id, providerId, model) { calls.push({ id, providerId, model }); return { id, providerModel: model, metadata: session.metadata } },
      async createSession(projectId, title) { calls.push({ create: title, projectId }); return { id: 'new1', title } },
      async listProjects() { return [{ id: 'p1', name: 'P1' }] },
      ...rest,
    },
    logger: noopLogger,
    subscribe: fakeSubscribe().subscribe,
  })
  conv._locale = 'fr'
  conv.state.projectId = 'p1'
  conv.state.sessionId = session ? session.id : null
  conv.state.stage = 'active'
  return { conv, telegram, calls }
}

const keyboardOf = (m) => m.extra?.reply_markup?.inline_keyboard?.flat() ?? []
const allCallbacksFit = (telegram) => telegram.sent.flatMap(keyboardOf).every((b) => typeof b.text === 'string' && Buffer.byteLength(b.callback_data) <= 64)

test('OpenFoxRestClient.listProviders returns the providers and the active provider id', async () => {
  const client = new OpenFoxRestClient({ baseUrl: 'http://x', fetchImpl: async () => ({ status: 200, json: async () => providersFixture() }) })
  const r = await client.listProviders()
  assert.equal(r.activeProviderId, P_ORCA)
  assert.equal(r.providers[0].models[0].id, GGUF)
})

test('/model lists the providers by name, marks the session one, and every button fits Telegram limits', async () => {
  const { conv, telegram } = modelConv()
  await conv.handleText('/model')
  const buttons = keyboardOf(telegram.sent.at(-1))
  const texts = buttons.map((b) => b.text)
  assert.ok(texts.some((t) => t.includes('llamacpp') && t.startsWith('✓')), JSON.stringify(texts))
  assert.ok(texts.some((t) => t.includes('OrcaRouter')))
  assert.ok(texts.some((t) => t.includes('OpenRouter (30)')), JSON.stringify(texts))
  assert.ok(!texts.some((t) => t.includes(P_LLAMA)), 'no UUID shown')
  assert.ok(allCallbacksFit(telegram))
})

test('choosing a model sets the exact model id (with ":" in it) on the session', async () => {
  const { conv, telegram, calls } = modelConv()
  await conv.handleText('/model')
  const prov = keyboardOf(telegram.sent.at(-1)).find((b) => b.text.includes('OpenRouter'))
  await conv.handleCallback(prov.callback_data)
  const batch = keyboardOf(telegram.sent.at(-1)).find((b) => b.text === 'anthropic/claude-haiku-5.5:batch')
  assert.ok(batch, JSON.stringify(keyboardOf(telegram.sent.at(-1)).map((b) => b.text)))
  await conv.handleCallback(batch.callback_data)
  assert.deepEqual(calls, [{ id: 's1', providerId: P_OPENR, model: 'anthropic/claude-haiku-5.5:batch' }])
  assert.match(telegram.sent.at(-1).text, /anthropic\/claude-haiku-5\.5:batch/)
  assert.match(telegram.sent.at(-1).text, /Ma session/)
  assert.ok(allCallbacksFit(telegram))
})

test('a local model path is shown by its file name and set with its full id', async () => {
  const { conv, telegram, calls } = modelConv({ session: { id: 's1', providerId: P_ORCA, providerModel: 'orcarouter/free' } })
  await conv.handleText('/model')
  await conv.handleCallback(keyboardOf(telegram.sent.at(-1)).find((b) => b.text.includes('llamacpp')).callback_data)
  const btn = keyboardOf(telegram.sent.at(-1)).find((b) => b.text.includes('.gguf'))
  assert.equal(btn.text, 'Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf')
  assert.match(telegram.sent.at(-1).text, /· 1 modèle$/m)
  await conv.handleCallback(btn.callback_data)
  assert.equal(calls[0].model, GGUF)
})

test('the current model is marked in its list', async () => {
  const { conv, telegram } = modelConv({ session: { id: 's1', providerId: P_ORCA, providerModel: 'orcarouter/fusion' } })
  await conv.handleText('/model')
  await conv.handleCallback(keyboardOf(telegram.sent.at(-1)).find((b) => b.text.includes('OrcaRouter')).callback_data)
  const texts = keyboardOf(telegram.sent.at(-1)).map((b) => b.text)
  assert.ok(texts.includes('✓ orcarouter/fusion'), JSON.stringify(texts))
  assert.ok(texts.includes('orcarouter/free'))
})

test('long model lists are paged, and typing a word filters them', async () => {
  const { conv, telegram, calls } = modelConv()
  await conv.handleText('/model')
  await conv.handleCallback(keyboardOf(telegram.sent.at(-1)).find((b) => b.text.includes('OpenRouter')).callback_data)
  const page1 = keyboardOf(telegram.sent.at(-1))
  assert.ok(page1.filter((b) => b.callback_data.startsWith('mdl:')).length <= 10)
  const next = page1.find((b) => b.text === '▶️')
  assert.ok(next, 'a next-page button')
  await conv.handleCallback(next.callback_data)
  assert.match(telegram.sent.at(-1).text, /2\/3/)
  // Typed text while the list is open filters the models (it is not sent to the agent).
  await conv.handleText('batch')
  const filtered = keyboardOf(telegram.sent.at(-1)).filter((b) => b.callback_data.startsWith('mdl:'))
  assert.deepEqual(filtered.map((b) => b.text), ['anthropic/claude-haiku-5.5:batch'])
  await conv.handleCallback(filtered[0].callback_data)
  assert.equal(calls[0].model, 'anthropic/claude-haiku-5.5:batch')
  assert.ok(allCallbacksFit(telegram))
})

test('a list that was replaced or closed cannot change a model any more', async () => {
  const { conv, telegram, calls } = modelConv()
  await conv.handleText('/model')
  await conv.handleCallback(keyboardOf(telegram.sent.at(-1)).find((b) => b.text.includes('OrcaRouter')).callback_data)
  const stale = keyboardOf(telegram.sent.at(-1)).find((b) => b.text === 'orcarouter/free')
  await conv.handleText('/model') // a new list replaces the old one
  await conv.handleCallback(stale.callback_data)
  assert.deepEqual(calls, [])
  assert.match(telegram.sent.at(-1).text, /expiré/)
})

test('creating a session asks for a model, also with /new_session <title>; "default" creates without one', async () => {
  for (const start of [['/new_session Démo'], ['/new_session', 'Démo']]) {
    const { conv, telegram, calls } = modelConv()
    for (const t of start) await conv.handleText(t)
    const buttons = keyboardOf(telegram.sent.at(-1))
    assert.ok(buttons.some((b) => b.text.includes('OpenRouter')), `${start}: ${JSON.stringify(buttons.map((b) => b.text))}`)
    const def = buttons.find((b) => b.callback_data.startsWith('mdf:'))
    await conv.handleCallback(def.callback_data)
    assert.deepEqual(calls, [{ create: 'Démo', projectId: 'p1' }])
    assert.equal(conv.state.sessionId, 'new1')
  }
})

test('creating a session with a chosen model sets it on the new session', async () => {
  const { conv, telegram, calls } = modelConv()
  await conv.handleText('/new_session Démo')
  await conv.handleCallback(keyboardOf(telegram.sent.at(-1)).find((b) => b.text.includes('OrcaRouter')).callback_data)
  await conv.handleCallback(keyboardOf(telegram.sent.at(-1)).find((b) => b.text === 'orcarouter/fusion').callback_data)
  assert.deepEqual(calls, [{ create: 'Démo', projectId: 'p1' }, { id: 'new1', providerId: P_ORCA, model: 'orcarouter/fusion' }])
  assert.equal(conv.state.sessionId, 'new1')
})

test('cancelling a creation closes its list: a late click changes nothing', async () => {
  const { conv, telegram, calls } = modelConv()
  await conv.handleText('/new_session Démo')
  await conv.handleCallback(keyboardOf(telegram.sent.at(-1)).find((b) => b.text.includes('OrcaRouter')).callback_data)
  const late = keyboardOf(telegram.sent.at(-1)).find((b) => b.text === 'orcarouter/free')
  const cancel = keyboardOf(telegram.sent.at(-1)).find((b) => b.callback_data.startsWith('mcx:'))
  await conv.handleCallback(cancel.callback_data)
  assert.match(telegram.sent.at(-1).text, /annulée/)
  await conv.handleCallback(late.callback_data)
  assert.deepEqual(calls, [], 'neither a creation nor a model change on the previous session')
  assert.equal(conv.state.sessionId, 's1')
})

test('an open model list does not swallow messages for ever', async () => {
  const sentToAgent = []
  const { conv } = modelConv({ rest: { async sendMessage(id, content) { sentToAgent.push(content); return {} } } })
  await conv.handleText('/model')
  conv._picker.shownAt -= 11 * 60 * 1000 // older than the list lifetime
  const turn = conv.handleText('fais le point')
  await sleep(10)
  assert.deepEqual(sentToAgent, ['fais le point'])
  conv.stopTurn()
  await turn
})

test('/status shows the default model when the session has none of its own', async () => {
  const { conv, telegram } = modelConv({ session: { id: 's1', providerId: null, providerModel: null } })
  await conv.handleText('/status')
  assert.match(telegram.sent.at(-1).text, /Modèle : modèle par défaut/)
})

// ---------------------------------------------------------------------------
// A question that no longer exists on OpenFox must not swallow messages.
// ---------------------------------------------------------------------------

function goneError() {
  const e = new Error('OpenFox 404: No pending question with that ID')
  e.status = 404
  return e
}

test('a typed answer to a question OpenFox no longer has goes to the agent as a normal message', async () => {
  const sentToSession = []
  const telegram = fakeTelegram()
  const { subscribe } = fakeSubscribe()
  const rest = {
    async getLocale() { return 'fr' },
    async answerQuestion() { throw goneError() },
    async sendMessage(id, content) { sentToSession.push({ id, content }); return {} },
  }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe })
  conv.state.sessionId = 's1'
  conv.state.stage = 'active'
  conv._showQuestion({ callId: 'q1', question: 'Nom ?', type: 'text' }, 's1')
  const turn = conv.handleText('fais plutôt le point')
  await sleep(10)
  assert.ok(!conv.hasPendingQuestion(), 'the stale question is dropped')
  assert.deepEqual(sentToSession, [{ id: 's1', content: 'fais plutôt le point' }])
  assert.ok(telegram.sent.some((m) => /n'attend plus de réponse/.test(m.text)), JSON.stringify(telegram.sent.map((m) => m.text)))
  conv.stopTurn()
  await turn
  // The next message is a normal message too.
  assert.ok(!conv.hasPendingQuestion())
})

test('a button answer to a question OpenFox no longer has says it expired, nothing is sent to the agent', async () => {
  const sentToSession = []
  const telegram = fakeTelegram()
  const rest = { async getLocale() { return 'fr' }, async answerQuestion() { throw goneError() }, async sendMessage(...a) { sentToSession.push(a); return {} } }
  const conv = new Conversation({ chatId: 1, telegram, rest, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv._showQuestion({ callId: 'q1', question: 'On y va ?', type: 'confirm' }, 's1')
  await sleep(5)
  const yes = telegram.sent.at(-1).extra.reply_markup.inline_keyboard.flat()[0].callback_data
  await conv.handleCallback(yes)
  assert.ok(!conv.hasPendingQuestion())
  assert.deepEqual(sentToSession, [])
  assert.match(telegram.sent.at(-1).text, /expiré/)
})

test('follow mode: the questions of an OpenFox turn are forgotten when that turn ends', async () => {
  const { conv, open } = followConv()
  conv.syncWatcher()
  const ev = open()[0].onEvent
  ev({ type: 'chat.ask_user', payload: { callId: 'qw', question: 'Quel nom ?', type: 'text' } })
  await sleep(5)
  assert.ok(conv.hasPendingQuestion())
  ev({ type: 'chat.done', payload: { messageId: 'w1', reason: 'complete' } })
  await sleep(5)
  assert.ok(!conv.hasPendingQuestion(), 'a message typed after the turn is not taken as an answer')
})

test('OpenFoxRestClient errors carry the HTTP status', async () => {
  const client = new OpenFoxRestClient({ baseUrl: 'http://x', fetchImpl: async () => ({ status: 404, json: async () => ({ error: 'No pending question with that ID' }) }) })
  const e = await client.answerQuestion('s', 'c', 'x').catch((err) => err)
  assert.equal(e.status, 404)
  assert.match(e.message, /No pending question/)
})

// ---------------------------------------------------------------------------
// A question's buttons go away however it is settled.
// ---------------------------------------------------------------------------

function questionTelegram() {
  const t = progressTelegram()
  t.edits = []
  t.editMessageReplyMarkup = async (chatId, messageId) => { t.edits.push(messageId) }
  return t
}
const choicePayload = { callId: 'qc', question: 'Quel langage ?', type: 'choice', options: [{ value: 'ts', label: 'TypeScript' }, { value: 'py', label: 'Python' }] }

test('a choice question answered with a typed (custom) answer loses its buttons', async () => {
  const telegram = questionTelegram()
  const answers = []
  const conv = new Conversation({ chatId: 1, telegram, rest: { async getLocale() { return 'fr' }, async answerQuestion(s, c, a) { answers.push(a) } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  conv._showQuestion(choicePayload, 's1')
  await sleep(5)
  const questionId = 100 + telegram.sent.findIndex((m) => m.text.includes('Quel langage'))
  await conv.handleText('Rust plutôt')
  assert.deepEqual(answers, ['Rust plutôt'])
  assert.deepEqual(telegram.edits, [questionId])
})

test('a question forgotten at the end of its turn, or gone on OpenFox, loses its buttons', async () => {
  // end of the turn
  const t1 = questionTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const c1 = new Conversation({ chatId: 1, telegram: t1, rest: { async getLocale() { return 'fr' }, async sendMessage() { return {} } }, logger: noopLogger, subscribe })
  const turn = c1.runTurn('s1', 'go')
  registered[0].onEvent({ type: 'chat.ask_user', payload: choicePayload })
  await sleep(5)
  const q1 = 100 + t1.sent.findIndex((m) => m.text.includes('Quel langage'))
  registered[0].onEvent({ type: 'chat.done', payload: { messageId: 'm', reason: 'complete' } })
  await turn
  assert.deepEqual(t1.edits, [q1])
  // gone on OpenFox (404)
  const t2 = questionTelegram()
  const gone = Object.assign(new Error('OpenFox 404: No pending question with that ID'), { status: 404 })
  const c2 = new Conversation({ chatId: 1, telegram: t2, rest: { async getLocale() { return 'fr' }, async answerQuestion() { throw gone } }, logger: noopLogger, subscribe: fakeSubscribe().subscribe })
  c2._showQuestion(choicePayload, 's1')
  await sleep(5)
  const q2 = 100 + t2.sent.findIndex((m) => m.text.includes('Quel langage'))
  await c2.handleCallback(t2.sent.find((m) => m.text.includes('Quel langage')).extra.reply_markup.inline_keyboard.flat()[0].callback_data)
  assert.deepEqual(t2.edits, [q2])
})

test('a question answered with a button loses its buttons once, not twice', async () => {
  const telegram = questionTelegram()
  const { subscribe, registered } = fakeSubscribe()
  const r = createRuntime({ telegram, rest: runtimeRest({ async answerQuestion() { return {} } }), subscribe, logger: noopLogger, auth: { userId: 1 } })
  r.start()
  telegram._push({ update_id: 1, message: { chat: { id: 7 }, from: { id: 1 }, text: '/send s1 go' } })
  assert.ok(await until(() => registered.length > 0))
  registered[0].onEvent({ type: 'chat.ask_user', payload: choicePayload })
  assert.ok(await until(() => telegram.sent.some((m) => m.text.includes('Quel langage'))))
  const q = telegram.sent.find((m) => m.text.includes('Quel langage'))
  const qId = 100 + telegram.sent.indexOf(q)
  telegram._push({ update_id: 2, callback_query: { id: 'cb', from: { id: 1 }, message: { message_id: qId, chat: { id: 7 } }, data: q.extra.reply_markup.inline_keyboard.flat()[1].callback_data } })
  assert.ok(await until(() => telegram.edits.length > 0))
  await sleep(60)
  r.stop()
  assert.deepEqual(telegram.edits, [qId])
})
