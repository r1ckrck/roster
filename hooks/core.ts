// Pure logic: no `$`, no I/O. Everything here is unit-tested in core.test.ts.

export const CARD_VERSION = 1
export const MAX_NOTES = 10
export const MAX_NOTE_CHARS = 200
export const MAX_CHANGED = 30
export const MAX_HOLD_FILES = 20
export const MAX_RUN_FILES = 100
export const MAX_NOTICES = 6
export const MAX_MACHINES = 3
export const RESOURCE = /^[A-Za-z0-9._-]{1,40}$/
export const SESSION_NAME = /^[A-Za-z0-9._-]{1,64}$/

export type Ready = 'ready' | 'wip'

export type Hold = {
  resource: string
  since: string
  how: 'command' | 'background' | 'manual'
  command?: string
  note?: string
  files: string[]
  filesTotal: number
}

export type Card = {
  roster: number
  sessionId: string
  /** The writer's Claude folder, whose session list says whether it runs. */
  configDir: string
  name: string
  root: string
  cwd: string
  status: string
  startedAt: string
  updatedAt: string
  humanAt: string | null
  ready: Ready | null
  notes: string[]
  changed: string[]
  changedTotal: number
  holds: Hold[]
}

export type Run = {
  resource: string
  by: string
  sessionId: string
  how: Hold['how']
  command?: string
  note?: string
  startedAt: string
  endedAt: string
  ok: boolean | null
  files: string[]
  filesTotal: number
}

export type RegistryEntry = {
  sessionId: string
  name: string
  cwd: string
  status: string
}

export type Peer = {
  sessionId: string
  name: string
  status: string
  card: Card | null
}

/** Another machine's front desk: a session that starts workers there on request. */
export type Machine = { desk: string; workers: string; about: string }

export type Config = { holds: Record<string, string[]>; machines: Machine[] }

// ---------- paths ----------

/** Forward slashes, no trailing slash (a bare drive or `/` keeps its own). */
export function normPath(p: string): string {
  const s = p.replace(/\\/g, '/')
  return s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, '') : s
}

/** The form two paths are compared in: Windows paths are case-insensitive. */
export function pathKey(p: string, isWin: boolean): string {
  const n = normPath(p)
  return isWin ? n.toLowerCase() : n
}

export function isInside(p: string, root: string, isWin: boolean): boolean {
  const a = pathKey(p, isWin)
  const r = pathKey(root, isWin)
  return a === r || a.startsWith(r.endsWith('/') ? r : r + '/')
}

/** `file` relative to `root` with forward slashes, or null when outside it. */
export function relPath(file: string, root: string, isWin: boolean): string | null {
  const f = normPath(file)
  const r = normPath(root)
  if (!isInside(f, r, isWin)) return null
  const rest = f.slice(r.length).replace(/^\/+/, '')
  return rest === '' ? null : rest
}

// ---------- git ----------

/** Paths from `git status --porcelain -z`; a rename keeps only its new path. */
export function parseGitStatus(z: string): string[] {
  const parts = z.split('\0')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    out.push(entry.slice(3))
    if (xy.includes('R') || xy.includes('C')) i++
  }
  return out
}

/** Whether `rel` is dirty: listed itself, or under an untracked folder git lists as `dir/`. */
export function isDirty(rel: string, dirty: readonly string[], isWin: boolean): boolean {
  const k = isWin ? rel.toLowerCase() : rel
  return dirty.some(d => {
    const dk = isWin ? d.toLowerCase() : d
    return dk === k || (dk.endsWith('/') && k.startsWith(dk))
  })
}

// ---------- config and holds ----------

export function parseConfig(text: string | undefined): Config {
  const holds: Record<string, string[]> = {}
  const machines: Machine[] = []
  if (!text) return { holds, machines }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { holds, machines } }
  const h = (raw as { holds?: unknown })?.holds
  if (h && typeof h === 'object') {
    for (const [resource, patterns] of Object.entries(h as Record<string, unknown>)) {
      if (!RESOURCE.test(resource) || !Array.isArray(patterns)) continue
      const list = patterns.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      if (list.length) holds[resource] = list
    }
  }
  const m = (raw as { machines?: unknown })?.machines
  if (Array.isArray(m)) {
    for (const entry of m) {
      if (machines.length === MAX_MACHINES) break
      const { desk, workers, about } = (entry ?? {}) as Record<string, unknown>
      if (typeof desk !== 'string' || !SESSION_NAME.test(desk)) continue
      machines.push({
        desk,
        workers: typeof workers === 'string' && SESSION_NAME.test(workers) ? workers : '',
        about: typeof about === 'string' ? about.trim().slice(0, MAX_NOTE_CHARS) : '',
      })
    }
  }
  return { holds, machines }
}

/** The project's file wins over the user's: resource by resource, and machines as a whole list. */
export function mergeConfig(user: Config, project: Config): Config {
  return {
    holds: { ...user.holds, ...project.holds },
    machines: project.machines.length ? project.machines : user.machines,
  }
}

/** Resources whose patterns appear in the command, case-insensitively. */
export function matchHolds(command: string, config: Config): string[] {
  const c = command.toLowerCase()
  return Object.entries(config.holds)
    .filter(([, patterns]) => patterns.some(p => c.includes(p.toLowerCase())))
    .map(([resource]) => resource)
}

// ---------- cards ----------

export function parseCard(text: string): Card | null {
  try {
    const c = JSON.parse(text) as Partial<Card>
    if (typeof c?.sessionId !== 'string' || typeof c.name !== 'string') return null
    return {
      roster: typeof c.roster === 'number' ? c.roster : CARD_VERSION,
      sessionId: c.sessionId,
      configDir: typeof c.configDir === 'string' ? c.configDir : '',
      name: c.name,
      root: typeof c.root === 'string' ? c.root : '',
      cwd: typeof c.cwd === 'string' ? c.cwd : '',
      status: typeof c.status === 'string' ? c.status : 'unknown',
      startedAt: typeof c.startedAt === 'string' ? c.startedAt : '',
      updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : '',
      humanAt: typeof c.humanAt === 'string' ? c.humanAt : null,
      ready: c.ready === 'ready' || c.ready === 'wip' ? c.ready : null,
      notes: Array.isArray(c.notes) ? c.notes.filter(n => typeof n === 'string') : [],
      changed: Array.isArray(c.changed) ? c.changed.filter(n => typeof n === 'string') : [],
      changedTotal: typeof c.changedTotal === 'number' ? c.changedTotal : 0,
      holds: Array.isArray(c.holds) ? c.holds.filter(h => typeof h?.resource === 'string') : [],
    }
  } catch {
    return null
  }
}

export function parseRun(text: string): Run | null {
  try {
    const r = JSON.parse(text) as Run
    return typeof r?.resource === 'string' && typeof r.by === 'string' ? r : null
  } catch {
    return null
  }
}

export function parseRegistryEntry(text: string): RegistryEntry | null {
  try {
    const r = JSON.parse(text) as Record<string, unknown>
    if (typeof r.sessionId !== 'string') return null
    return {
      sessionId: r.sessionId,
      name: typeof r.name === 'string' ? r.name : r.sessionId.slice(0, 8),
      cwd: typeof r.cwd === 'string' ? r.cwd : '',
      status: typeof r.status === 'string' ? r.status : 'unknown',
    }
  } catch {
    return null
  }
}

/** Notes as stored: trimmed, non-empty, at most MAX_NOTES of MAX_NOTE_CHARS. */
export function capNotes(notes: readonly string[]): string[] {
  return notes
    .map(n => n.replace(/\s+/g, ' ').trim())
    .filter(n => n !== '')
    .slice(0, MAX_NOTES)
    .map(n => (n.length > MAX_NOTE_CHARS ? n.slice(0, MAX_NOTE_CHARS - 1) + '…' : n))
}

export const LIVE_GRACE_MS = 60_000
export const HEARTBEAT_STALE_MS = 3 * 60_000
export const DEAD_DELETE_MS = 10 * 60_000

/**
 * Whether a card's session is running. With the engine's session list
 * (`liveIds`) the list decides, a card written in the last minute aside
 * (a session that just started or was just cleared); without it, the card's
 * own heartbeat does.
 */
export function isCardLive(card: Card, liveIds: ReadonlySet<string> | null, now: number): boolean {
  const age = now - (Date.parse(card.updatedAt) || 0)
  if (liveIds) return liveIds.has(card.sessionId) || age < LIVE_GRACE_MS
  return age < HEARTBEAT_STALE_MS
}

/**
 * The session list a card is judged by: ours only when the card was written
 * from the same Claude folder. Another OS user's sessions are not in our list,
 * so their cards go by heartbeat instead of looking dead.
 */
export function listFor(card: Card, configDir: string, liveIds: ReadonlySet<string> | null, isWin: boolean): ReadonlySet<string> | null {
  return card.configDir && pathKey(card.configDir, isWin) === pathKey(configDir, isWin) ? liveIds : null
}

/** Whether a dead card may be deleted now. */
export function isCardRemovable(card: Card | null, mtimeMs: number, liveIds: ReadonlySet<string> | null, now: number): boolean {
  if (card === null) return now - mtimeMs > LIVE_GRACE_MS
  if (isCardLive(card, liveIds, now)) return false
  return liveIds !== null || now - (Date.parse(card.updatedAt) || 0) > DEAD_DELETE_MS
}

// ---------- text ----------

export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

const since = (iso: string | null, now: number) => (iso ? age(now - (Date.parse(iso) || now)) : '?')

/** A label that tells apart agents that share a name. */
export function labels(peers: readonly { sessionId: string; name: string }[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const p of peers) counts.set(p.name, (counts.get(p.name) ?? 0) + 1)
  return new Map(peers.map(p => [p.sessionId, (counts.get(p.name) ?? 0) > 1 ? `${p.name} (${p.sessionId.slice(0, 6)})` : p.name]))
}

function holdText(h: Hold, now: number): string {
  const what = h.how === 'manual' ? h.note : h.command
  return `${h.resource} for ${since(h.since, now)}${what ? ` (${what})` : ''}`
}

/** One line about one agent, for the start note and the board. */
export function peerLine(p: Peer, label: string, now: number): string {
  const parts = [label, p.status]
  const c = p.card
  if (!c) return [...parts, 'no roster card'].join(' · ')
  parts.push(c.humanAt ? `human ${since(c.humanAt, now)} ago` : 'no human input yet')
  if (c.ready) parts.push(c.ready === 'ready' ? 'ready to ship' : 'work in progress')
  if (c.holds.length) parts.push('holds ' + c.holds.map(h => holdText(h, now)).join(', '))
  if (c.changedTotal) parts.push(`${c.changedTotal} changed file${c.changedTotal === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

export const TOOL_NAMES = {
  board: 'mcp__roster__board',
  hold: 'mcp__roster__hold',
  release: 'mcp__roster__release',
  update: 'mcp__roster__update',
}

/** How an agent reaches another machine through its desk; one line. */
export function machineLine(m: Machine): string {
  const where = m.about ? `Other machine (${m.about})` : 'Other machine'
  // A worker treats a one-off request as its whole task and closes itself after reporting.
  const finish = m.workers
    ? ` It starts a worker named ${m.workers}<task> and replies with the name; message that worker directly (if a new worker is not reachable yet, list peers with ListAgents and retry). A worker closes itself after its report, unless your request says the work takes several exchanges: then keep using it and tell it once the whole task is done.`
    : ' Tell it once the whole task is done, not after each step.'
  return `${where}: for work there, message "${m.desk}" (SendMessage).${finish}`
}

/** What the agent reads once per conversation: at most ~10 lines, plus one per configured machine. */
export function renderStartNote(
  me: { name: string; liveDir: string },
  peers: readonly Peer[],
  now: number,
  machines: readonly Machine[] = [],
): string {
  const l = labels(peers)
  const shown = peers.slice(0, 4)
  const lines = [
    `roster is on: agents working in this project can see each other. You are "${me.name}".`,
    `Each live agent has a card in ${me.liveDir}/ (JSON: status, changed files, holds, notes); runs/ keeps the last run of each shared resource.`,
  ]
  if (shown.length === 0) lines.push('No other agents are here now.')
  else {
    lines.push('Here now:')
    for (const p of shown) lines.push('- ' + peerLine(p, l.get(p.sessionId) ?? p.name, now))
    if (peers.length > shown.length) lines.push(`- and ${peers.length - shown.length} more (see the board)`)
  }
  lines.push(
    `Tools (load with ToolSearch): ${TOOL_NAMES.board} shows everyone; ${TOOL_NAMES.hold} and ${TOOL_NAMES.release} mark a shared resource such as a build or deploy; ${TOOL_NAMES.update} sets ready or work in progress and short notes for peers.`,
    'Look at the cards before asking a peer; message one (SendMessage) only for what the cards cannot answer. The board lists every agent in this project; any other peer in ListAgents is in another folder or on another machine.',
  )
  for (const m of machines) lines.push(machineLine(m))
  return lines.join('\n')
}

export function renderBoard(
  me: { card: Card; liveDir: string },
  peers: readonly Peer[],
  runs: readonly Run[],
  now: number,
): string {
  const all: Peer[] = [{ sessionId: me.card.sessionId, name: me.card.name, status: me.card.status, card: me.card }, ...peers]
  const l = labels(all)
  const out = [`roster · ${me.liveDir}`]
  for (const p of all) {
    const label = (l.get(p.sessionId) ?? p.name) + (p.sessionId === me.card.sessionId ? ' (you)' : '')
    out.push(peerLine(p, label, now))
    const c = p.card
    if (!c) continue
    if (c.changed.length) {
      const shown = c.changed.slice(0, 8)
      const more = Math.max(c.changedTotal, c.changed.length) - shown.length
      out.push(`  changed: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`)
    }
    for (const h of c.holds) if (h.filesTotal) out.push(`  ${h.resource} will include ${h.filesTotal} changed file${h.filesTotal === 1 ? '' : 's'}`)
    for (const n of c.notes) out.push(`  note: ${n}`)
  }
  if (runs.length) {
    out.push('last runs:')
    for (const r of runs) {
      const result = r.ok === null ? '' : r.ok ? ', ok' : ', failed'
      out.push(`- ${r.resource}: ${r.by}, ended ${age(now - (Date.parse(r.endedAt) || now))} ago${result}, ${r.filesTotal} changed file${r.filesTotal === 1 ? '' : 's'} in`)
    }
  }
  return out.join('\n')
}

// ---------- notices ----------

export type Snapshot = Map<string, { name: string; holds: Set<string> }>

export function snapshot(peers: readonly Peer[]): Snapshot {
  return new Map(peers.map(p => [p.sessionId, { name: p.name, holds: new Set(p.card?.holds.map(h => h.resource) ?? []) }]))
}

/** One line per change worth an interruption: joins, leaves, holds taken and freed. */
export function diffNotices(prev: Snapshot, next: Snapshot): string[] {
  const out: string[] = []
  for (const [id, n] of next) {
    const p = prev.get(id)
    if (!p) {
      out.push(`roster: ${n.name} joined.`)
      for (const r of n.holds) out.push(`roster: ${n.name} holds ${r}.`)
      continue
    }
    for (const r of n.holds) if (!p.holds.has(r)) out.push(`roster: ${n.name} took ${r}.`)
    for (const r of p.holds) if (!n.holds.has(r)) out.push(`roster: ${r} is free (${n.name} released it).`)
  }
  for (const [id, p] of prev) {
    if (next.has(id)) continue
    out.push(`roster: ${p.name} left.`)
    for (const r of p.holds) out.push(`roster: ${r} is free (${p.name} left).`)
  }
  return out
}

/** Drains queued notices into at most MAX_NOTICES lines. */
export function drainNotices(queue: string[]): string | null {
  if (queue.length === 0) return null
  const lines = [...new Set(queue.splice(0, queue.length))]
  const shown = lines.slice(0, MAX_NOTICES)
  if (lines.length > shown.length) shown.push(`roster: ${lines.length - shown.length} more changes; ${TOOL_NAMES.board} shows them.`)
  return shown.join('\n')
}

export function holdWarning(resource: string, holders: readonly Peer[], now: number, mode: 'pause' | 'warn'): string {
  const who = holders
    .map(p => {
      const h = p.card?.holds.find(x => x.resource === resource)
      return `${p.name}${h ? ` for ${since(h.since, now)}${h.command ? ` (${h.command})` : h.note ? ` (${h.note})` : ''}` : ''}`
    })
    .join(', ')
  const head = `roster: ${resource} is held by ${who}.`
  return mode === 'pause'
    ? `${head} Nothing ran. Wait for it (you get a note when it is free), ask the holder, or run the same command again to go ahead anyway.`
    : `${head} This ran alongside it.`
}

export function shorten(text: string, max = 120): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}
