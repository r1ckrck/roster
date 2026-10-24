import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import {
  CARD_VERSION, MAX_CHANGED, MAX_HOLD_FILES, MAX_RUN_FILES, RESOURCE, TOOL_NAMES,
  capNotes, diffNotices, drainNotices, holdWarning, isCardLive, isCardRemovable, isDirty, isInside, listFor,
  matchHolds, mergeConfig, normPath, parseCard, parseConfig, parseGitStatus, parseRegistryEntry,
  parseRun, pathKey, relPath, renderBoard, renderStartNote, shorten, snapshot,
} from './core.ts'
import type { Card, Config, Hold, Peer, Ready, RegistryEntry, Run, Snapshot } from './core.ts'

type $ = EngineInterface

const TICK_MS = 30_000
const PAUSE_REPEAT_MS = 10 * 60_000

type State = {
  isWin: boolean
  configDir: string
  cwd: string
  root: string
  gitTop: string
  isGit: boolean
  liveDir: string
  runsDir: string
  sessionId: string
  name: string
  status: string
  startedAt: number
  humanAt: number | null
  ready: Ready | null
  notes: string[]
  edited: string[]
  changed: string[]
  holds: Hold[]
  config: Config
  peers: Peer[]
  snap: Snapshot | null
  queue: string[]
  warnedShared: Set<string>
  paused: Map<string, number>
  tick: { cancel: () => void } | null
}

let S: State | null = null
let writing: Promise<void> = Promise.resolve()

const iso = (ms: number) => new Date(ms).toISOString()

async function readText($: $, path: string): Promise<string | undefined> {
  try { return await $.fs.read(path) } catch { return undefined }
}

async function deleteFile($: $, s: State, path: string): Promise<void> {
  try {
    if (s.isWin) {
      // The path rides an environment variable: no quoting survives `&` and spaces otherwise.
      await $.process.run(
        ['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Remove-Item -LiteralPath $env:ROSTER_PATH -Force -ErrorAction SilentlyContinue'],
        { env: { ROSTER_PATH: path.replace(/\//g, '\\') } },
      )
    } else {
      await $.process.run(['rm', '-f', path])
    }
  } catch { /* a peer cleans up what is left */ }
}

/** The engine's own list of running sessions, or null when it cannot be read. */
async function readRegistry($: $, s: State): Promise<RegistryEntry[] | null> {
  const dir = `${s.configDir}/sessions`
  try {
    const entries = await $.fs.list(dir)
    const out: RegistryEntry[] = []
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
      const text = await readText($, `${dir}/${e.name}`)
      const r = text === undefined ? null : parseRegistryEntry(text)
      if (r) out.push(r)
    }
    return out
  } catch {
    return null
  }
}

async function gitDirty($: $, s: State): Promise<string[] | null> {
  if (!s.isGit) return null
  try {
    const r = await $.process.run(['git', 'status', '--porcelain', '-z'], { cwd: s.gitTop })
    return r.exitCode === 0 ? parseGitStatus(r.stdout) : null
  } catch {
    return null
  }
}

/** Changed files: what this session edited that git still sees as changed. */
async function refreshChanged($: $, s: State): Promise<void> {
  const dirty = await gitDirty($, s)
  if (dirty === null) {
    s.changed = s.edited.slice(-MAX_CHANGED).reverse()
    return
  }
  s.edited = s.edited.filter(f => isDirty(f, dirty, s.isWin))
  s.changed = s.edited.slice().reverse()
}

async function readConfig($: $, s: State): Promise<Config> {
  const user = parseConfig(await readText($, `${s.configDir}/roster.json`))
  const project = parseConfig(await readText($, `${s.root}/.claude/roster.json`))
  return mergeConfig(user, project)
}

function cardOf(s: State, now: number): Card {
  return {
    roster: CARD_VERSION,
    sessionId: s.sessionId,
    configDir: s.configDir,
    name: s.name,
    root: s.root,
    cwd: s.cwd,
    status: s.status,
    startedAt: iso(s.startedAt),
    updatedAt: iso(now),
    humanAt: s.humanAt === null ? null : iso(s.humanAt),
    ready: s.ready,
    notes: s.notes,
    changed: s.changed.slice(0, MAX_CHANGED),
    changedTotal: s.changed.length,
    holds: s.holds,
  }
}

async function writeCardNow($: $, s: State): Promise<void> {
  const id = await $.session.id()
  if (id !== s.sessionId) {
    // A /clear goes on under a new session id: the old card goes with it.
    const old = `${s.liveDir}/${s.sessionId}.json`
    s.sessionId = id
    await $.fs.write(old, '')
    await deleteFile($, s, old)
  }
  await $.fs.write(`${s.liveDir}/${s.sessionId}.json`, JSON.stringify(cardOf(s, await $.clock.now()), null, 2) + '\n')
}

/** Card writes run one at a time, in order. */
function persist($: $, s: State): Promise<void> {
  writing = writing.then(() => writeCardNow($, s)).catch(() => {})
  return writing
}

/** Rereads the session list and every card; queues notices when asked. */
async function refresh($: $, s: State, notify: boolean): Promise<void> {
  const now = await $.clock.now()
  const registry = await readRegistry($, s)
  const own = registry?.find(r => r.sessionId === s.sessionId)
  // The list is trusted only when it knows this session: its format is the engine's, not ours.
  const liveIds = own ? new Set(registry!.map(r => r.sessionId)) : null
  if (own) {
    s.name = own.name
    s.status = own.status
  }
  const byId = new Map((registry ?? []).map(r => [r.sessionId, r]))

  const peers = new Map<string, Peer>()
  let entries: Awaited<ReturnType<$['fs']['list']>> = []
  try { entries = await $.fs.list(s.liveDir) } catch { entries = [] }
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    const id = e.name.slice(0, -5)
    if (id === s.sessionId) continue
    const path = `${s.liveDir}/${e.name}`
    const text = await readText($, path)
    const card = text === undefined ? null : parseCard(text)
    const ids = card ? listFor(card, s.configDir, liveIds, s.isWin) : liveIds
    if (card && isCardLive(card, ids, now)) {
      const r = byId.get(card.sessionId)
      peers.set(card.sessionId, { sessionId: card.sessionId, name: r?.name ?? card.name, status: r?.status ?? card.status, card })
    } else if (isCardRemovable(card, e.mtimeMs, ids, now)) {
      await deleteFile($, s, path)
    }
  }
  // Sessions in this project without the mod still count as here.
  for (const r of registry ?? []) {
    if (r.sessionId === s.sessionId || peers.has(r.sessionId) || !r.cwd || !isInside(r.cwd, s.root, s.isWin)) continue
    peers.set(r.sessionId, { sessionId: r.sessionId, name: r.name, status: r.status, card: null })
  }

  s.peers = [...peers.values()].sort((a, b) => a.name.localeCompare(b.name))
  const next = snapshot(s.peers)
  if (s.snap && notify) s.queue.push(...diffNotices(s.snap, next))
  s.snap = next
}

async function writeRun($: $, s: State, hold: Hold, ok: boolean | null): Promise<void> {
  const run: Run = {
    resource: hold.resource,
    by: s.name,
    sessionId: s.sessionId,
    how: hold.how,
    ...(hold.command ? { command: hold.command } : {}),
    ...(hold.note ? { note: hold.note } : {}),
    startedAt: hold.since,
    endedAt: iso(await $.clock.now()),
    ok,
    files: hold.files,
    filesTotal: hold.filesTotal,
  }
  try { await $.fs.write(`${s.runsDir}/${hold.resource}.json`, JSON.stringify(run, null, 2) + '\n') } catch { /* the run record is a courtesy */ }
}

async function takeHold($: $, s: State, resource: string, how: Hold['how'], text?: string): Promise<void> {
  const dirty = (await gitDirty($, s)) ?? s.changed
  s.holds.push({
    resource,
    since: iso(await $.clock.now()),
    how,
    ...(how === 'manual' ? (text ? { note: shorten(text) } : {}) : { command: shorten(text ?? '') }),
    files: dirty.slice(0, MAX_HOLD_FILES),
    filesTotal: dirty.length,
  })
}

async function releaseHold($: $, s: State, resource: string, ok: boolean | null, record: boolean): Promise<boolean> {
  const i = s.holds.findIndex(h => h.resource === resource)
  const hold = s.holds[i]
  if (!hold) return false
  s.holds.splice(i, 1)
  if (record) {
    const dirty = (await gitDirty($, s)) ?? s.changed
    const files = hold.filesTotal ? hold.files : dirty.slice(0, MAX_RUN_FILES)
    await writeRun($, s, { ...hold, files, filesTotal: hold.filesTotal || dirty.length }, ok)
  }
  return true
}

/** A tool result with this session's queued notices (and any lines of its own) after it. */
function withNotes<R extends ToolCallResult>(s: State, r: R, extra: string[] = []): R {
  if (r.deny !== undefined) return r
  const queued = drainNotices(s.queue)
  const lines = [...extra, ...(queued ? [queued] : [])]
  return lines.length ? { ...r, context: [...(r.context ?? []), lines.join('\n')] } : r
}

const holdersOf = (s: State, resource: string) => s.peers.filter(p => p.card?.holds.some(h => h.resource === resource))

async function board($: $, s: State): Promise<string> {
  await refresh($, s, false)
  s.queue.length = 0
  const runs: Run[] = []
  try {
    for (const e of await $.fs.list(s.runsDir)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
      const r = parseRun((await readText($, `${s.runsDir}/${e.name}`)) ?? '')
      if (r) runs.push(r)
    }
  } catch { /* no runs yet */ }
  runs.sort((a, b) => a.resource.localeCompare(b.resource))
  const now = await $.clock.now()
  return renderBoard({ card: cardOf(s, now), liveDir: s.liveDir }, s.peers, runs, now)
}

async function answerTool($: $, s: State, tool: string, input: Record<string, unknown>): Promise<string> {
  if (tool === TOOL_NAMES.board) return board($, s)

  if (tool === TOOL_NAMES.hold || tool === TOOL_NAMES.release) {
    const resource = typeof input.resource === 'string' ? input.resource.trim() : ''
    if (!RESOURCE.test(resource)) return 'roster: name the resource with letters, digits, ".", "_" or "-" (up to 40), for example "build" or "deploy".'
    if (tool === TOOL_NAMES.release) {
      const released = await releaseHold($, s, resource, null, true)
      if (released) await persist($, s)
      return released ? `roster: released ${resource}. Peers see it is free.` : `roster: you do not hold ${resource}.`
    }
    if (s.holds.some(h => h.resource === resource)) return `roster: you already hold ${resource}.`
    await refresh($, s, false)
    const holders = holdersOf(s, resource)
    await takeHold($, s, resource, 'manual', typeof input.note === 'string' ? input.note : undefined)
    await persist($, s)
    const also = holders.length ? ` Also held by ${holders.map(p => p.name).join(', ')}.` : ''
    return `roster: you hold ${resource}. Release it with ${TOOL_NAMES.release} when done.${also}`
  }

  if (tool === TOOL_NAMES.update) {
    const said: string[] = []
    if (input.ready === 'ready' || input.ready === 'wip') {
      s.ready = input.ready
      said.push(input.ready === 'ready' ? 'marked ready to ship' : 'marked work in progress')
    } else if (input.ready === 'clear') {
      s.ready = null
      said.push('cleared ready')
    }
    if (Array.isArray(input.notes)) {
      s.notes = capNotes(input.notes.filter((n): n is string => typeof n === 'string'))
      said.push(s.notes.length ? `${s.notes.length} note${s.notes.length === 1 ? '' : 's'} on your card` : 'notes cleared')
    }
    if (!said.length) return 'roster: nothing to change; pass ready, notes, or both.'
    await persist($, s)
    return `roster: ${said.join(', ')}.`
  }

  return `roster: no tool named ${tool}.`
}

const TOOLS = [
  {
    name: 'board',
    description: 'Shows every agent working in this project right now: status, when its human last typed, ready or work in progress, changed files not yet committed, shared resources it holds, its notes, and the last run of each shared resource. Read this before asking a peer.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hold',
    description: 'Marks a shared resource (a build, a deploy, a dev server, a test run, a running app) as yours so peers see it before they use it. Commands listed in roster.json hold their resource on their own while they run; use this for the rest. Release it when done.',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'Short name, e.g. "build" or "deploy".' },
        note: { type: 'string', description: 'Optional: what you are doing with it, one line.' },
      },
      required: ['resource'],
    },
  },
  {
    name: 'release',
    description: 'Frees a shared resource you hold, and records the run so peers can see who last ran it and what went in.',
    inputSchema: {
      type: 'object',
      properties: { resource: { type: 'string', description: 'The resource you hold.' } },
      required: ['resource'],
    },
  },
  {
    name: 'update',
    description: 'Updates your card: whether your changes are ready to ship, and short notes peers should know (a rename, a contract change, a gotcha). Notes replace the old ones; at most 10 lines.',
    inputSchema: {
      type: 'object',
      properties: {
        ready: { type: 'string', enum: ['ready', 'wip', 'clear'], description: 'ready: fine to ship as it stands; wip: not yet; clear: say neither.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'The full list of notes; [] clears them.' },
      },
    },
  },
]

async function start($: $, cwd: string): Promise<State> {
  const isWin = (await $.env.get('OS')) === 'Windows_NT'
  const home = normPath((isWin ? await $.env.get('USERPROFILE') : await $.env.get('HOME')) ?? '')
  const configDir = normPath((await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`)
  const repo = await $.session.repo().catch(() => null)
  const root = normPath(repo?.root ?? (await $.session.root()))
  let gitTop = root
  let isGit = false
  if (repo) {
    try {
      const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
      if (r.exitCode === 0) { gitTop = normPath(r.stdout.trim()); isGit = true }
    } catch { /* treated as a plain folder */ }
  }
  const liveDir = `${root}/.claude/live`
  const sessionId = await $.session.id()
  const s: State = {
    isWin, configDir, cwd: normPath(cwd), root, gitTop, isGit, liveDir, runsDir: `${liveDir}/runs`,
    sessionId, name: sessionId.slice(0, 8), status: 'unknown', startedAt: await $.clock.now(),
    humanAt: null, ready: null, notes: [], edited: [], changed: [], holds: [],
    config: { holds: {}, machines: [] }, peers: [], snap: null, queue: [], warnedShared: new Set(), paused: new Map(), tick: null,
  }

  // A reload of the module keeps the card: pick up where it was.
  const prior = parseCard((await readText($, `${liveDir}/${sessionId}.json`)) ?? '')
  if (prior) {
    s.startedAt = Date.parse(prior.startedAt) || s.startedAt
    s.humanAt = prior.humanAt ? Date.parse(prior.humanAt) || null : null
    s.ready = prior.ready
    s.notes = prior.notes
    s.edited = prior.changed.slice().reverse()
    // A command's hold belonged to the module that ran it; that run's end is not coming back.
    s.holds = prior.holds.filter(h => h.how !== 'command')
  }

  s.config = await readConfig($, s)
  await refresh($, s, false)
  await refreshChanged($, s)
  await persist($, s)
  return s
}

/** Says once per project, ever, when git would pick up the cards. */
async function checkIgnored($: $, s: State): Promise<void> {
  if (!s.isGit || pathKey(s.gitTop, s.isWin) !== pathKey(s.root, s.isWin)) return
  try {
    const r = await $.process.run(['git', 'check-ignore', '-q', '.claude/live/roster-probe.json'], { cwd: s.gitTop })
    if (r.exitCode !== 1) return
    const warned = ((await $.store.get('unignored')) as string[] | undefined) ?? []
    const key = pathKey(s.root, s.isWin)
    if (warned.includes(key)) return
    await $.store.set('unignored', [...warned, key])
    $.ui.toast(`roster: .claude/live/ is not ignored by git in ${s.root}. Add .claude/ (or .claude/live/) to .gitignore.`, { timeoutMs: 10_000 })
  } catch { /* nothing to say */ }
}

async function tick($: $, s: State): Promise<void> {
  if (S !== s) return
  s.config = await readConfig($, s)
  await refresh($, s, true)
  await refreshChanged($, s)
  await persist($, s)
}

export const register: Register = (on, options) => {
  const mode: 'pause' | 'warn' = options.onHeldResource === 'warn' ? 'warn' : 'pause'

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      S?.tick?.cancel()
      const s = await start($, e.cwd)
      S = s
      for (const t of TOOLS) await $.tool.register(t)
      await $.command.register({ name: 'roster', description: 'Shows who else is working in this project and what they hold.' })
      s.tick = $.clock.every(TICK_MS, () => { void tick($, s).catch(() => {}) })
      await checkIgnored($, s)
    } catch (err) {
      S = null
      $.ui.log(`roster: could not start, so it stays off this session: ${String(err)}`)
    }
    return r
  })

  on('prompt.context', async ($, e, next) => {
    const r = await next(e)
    const s = S
    if (!s) return r
    await refresh($, s, false)
    s.queue.length = 0
    const note = renderStartNote({ name: s.name, liveDir: s.liveDir }, s.peers, await $.clock.now(), s.config.machines)
    return { ...r, blocks: [...r.blocks, { name: 'roster', text: note }] }
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const s = S
    if (!s) return next(e)
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      s.humanAt = await $.clock.now()
      void persist($, s)
    }
    const queued = drainNotices(s.queue)
    return next(queued ? { ...e, context: [...(e.context ?? []), queued] } : e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'roster' }, async $ => {
    const s = S
    return { text: s ? await board($, s) : 'roster is off in this session: it could not start (the debug log says why).' }
  })

  on('tool.call', async ($, e, next) => {
    const s = S
    if (!s) return next(e)

    if (e.tool.startsWith('mcp__roster__')) {
      return { result: await answerTool($, s, e.tool, e as unknown as Record<string, unknown>) }
    }

    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
      const r = await next(e)
      const rel = r.deny === undefined && !r.isError ? relPath(path, s.gitTop, s.isWin) : null
      if (!rel || rel.startsWith('.claude/live/')) return withNotes(s, r)
      const k = s.isWin ? rel.toLowerCase() : rel
      const same = (f: string) => (s.isWin ? f.toLowerCase() : f) === k
      s.edited = [...s.edited.filter(f => !same(f)), rel]
      s.changed = [rel, ...s.changed.filter(f => !same(f))]
      const heads: string[] = []
      for (const p of s.peers) {
        if (!p.card?.changed.some(same)) continue
        const key = `${p.sessionId}:${k}`
        if (s.warnedShared.has(key)) continue
        s.warnedShared.add(key)
        heads.push(`roster: ${p.name} also has uncommitted changes in ${rel}. Both can edit it; re-read before a large rewrite.`)
      }
      void persist($, s)
      return withNotes(s, r, heads)
    }

    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      const command = e.command
      const touchesGit = /\bgit\b/.test(command)
      const resources = matchHolds(command, s.config)
      if (!resources.length) {
        const r = await next(e)
        if (touchesGit) { await refreshChanged($, s); void persist($, s) }
        return withNotes(s, r)
      }

      await refresh($, s, true)
      const now = await $.clock.now()
      const warnings: string[] = []
      for (const resource of resources) {
        const holders = holdersOf(s, resource)
        if (!holders.length) continue
        const pausedAt = s.paused.get(resource)
        if (mode === 'pause' && !(pausedAt !== undefined && now - pausedAt < PAUSE_REPEAT_MS)) {
          s.paused.set(resource, now)
          const queued = drainNotices(s.queue)
          return { deny: [holdWarning(resource, holders, now, 'pause'), ...(queued ? [queued] : [])].join('\n') }
        }
        warnings.push(holdWarning(resource, holders, now, 'warn'))
      }

      const isBackground = e.run_in_background === true
      const acquired: string[] = []
      for (const resource of resources) {
        if (s.holds.some(h => h.resource === resource)) continue
        await takeHold($, s, resource, isBackground ? 'background' : 'command', command)
        acquired.push(resource)
      }
      await persist($, s)

      let ok: boolean | null = null
      let ran = false
      try {
        const r = await next(e)
        ran = r.deny === undefined
        ok = ran ? !r.isError : null
        if (isBackground && ran) {
          for (const resource of acquired) {
            warnings.push(`roster: you hold ${resource} while this runs in the background. Call ${TOOL_NAMES.release} with resource "${resource}" when it finishes.`)
          }
        }
        return withNotes(s, r, warnings)
      } finally {
        if (!isBackground || !ran) {
          for (const resource of acquired) await releaseHold($, s, resource, ok, ran)
        }
        await refreshChanged($, s)
        await persist($, s)
      }
    }

    return withNotes(s, await next(e))
  }).catch(($, e, next) => (e.tool.startsWith('mcp__roster__') && !next.called ? { result: 'roster: that failed; try again, or read the cards directly.' } : next(e)))

  on('session.end', async ($, e, next) => {
    const s = S
    if (s && e.reason !== 'clear') {
      S = null
      s.tick?.cancel()
      for (const h of [...s.holds]) await releaseHold($, s, h.resource, null, true)
      const own = `${s.liveDir}/${s.sessionId}.json`
      await writing
      try { await $.fs.write(own, '') } catch { /* peers clean up */ }
      await deleteFile($, s, own)
    }
    return next(e)
  })
}
