import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// An in-memory machine: files, the engine's session list, git, and the delete command.
// It matches the host, since the engine resolves paths the host's way before the fakes see them.
const WIN = /^file:\/\/\/[A-Za-z]:/.test(import.meta.url)
const ROOT = WIN ? 'C:/proj' : '/proj'
const HOME = WIN ? 'C:/Users/me' : '/home/me'
const ELSEWHERE = WIN ? 'D:/elsewhere' : '/elsewhere'
const LIVE = `${ROOT}/.claude/live`
const SESSIONS = `${HOME}/.claude/sessions`
const T0 = Date.parse('2026-10-21T12:00:00.000Z')

type World = { files: Map<string, string>; dirty: string; ran: string[][]; toasts: string[] }

const norm = (p: string) => p.replace(/\\/g, '/')
/** A path as the engine hands it over on this host. */
const native = (p: string) => (WIN ? p.replace(/\//g, '\\') : p)

function world(on: On, files: Record<string, string>, dirty = ''): World {
  const w: World = { files: new Map(Object.entries(files).map(([k, v]) => [norm(k), v])), dirty, ran: [], toasts: [] }
  mock.env(on, WIN ? { OS: 'Windows_NT', USERPROFILE: native(HOME) } : { HOME })
  mock.store(on)
  on('session.id', () => ({ value: 'me-1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: null } }))
  on('fs.read', ($, e) => {
    const text = w.files.get(norm(e.path))
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => { w.files.set(norm(e.path), e.text); return { value: undefined } })
  on('fs.exists', ($, e) => ({ value: w.files.has(norm(e.path)) }))
  on('fs.list', ($, e) => {
    const dir = norm(e.path).replace(/\/$/, '') + '/'
    const names = [...w.files.keys()].filter(k => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
    if (!names.length) throw new Error(`ENOENT ${e.path}`)
    return { value: names.map(k => ({ name: k.slice(dir.length), kind: 'file' as const, size: 1, mtimeMs: T0 - 3_600_000, isLink: false })) }
  })
  on('process.run', ($, e) => {
    w.ran.push([...e.argv])
    const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [cmd, sub] = e.argv
    if (cmd === 'git' && sub === 'rev-parse') return done(0, `${ROOT}\n`)
    if (cmd === 'git' && sub === 'status') return done(0, w.dirty)
    if (cmd === 'git' && sub === 'check-ignore') return done(0)
    if (cmd === 'powershell') { w.files.delete(norm(e.init?.env?.ROSTER_PATH ?? '')); return done(0) }
    if (cmd === 'rm') { w.files.delete(norm(e.argv[2] ?? '')); return done(0) }
    return done(1)
  })
  on('ui.toast', ($, e) => { w.toasts.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', ($, e) => ({ value: { tool: e.name } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.context', ($, e) => ({ blocks: e.blocks }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  return w
}

const registry = (sessionId: string, name: string, cwd = native(ROOT), status = 'busy') =>
  JSON.stringify({ pid: 1, sessionId, cwd, name, status })

const peerCard = (over: Record<string, unknown> = {}) => JSON.stringify({
  roster: 1, sessionId: 'art-1', configDir: `${HOME}/.claude`, name: 'art', root: ROOT, cwd: ROOT, status: 'busy',
  startedAt: new Date(T0 - 3_600_000).toISOString(), updatedAt: new Date(T0 - 5_000).toISOString(),
  humanAt: new Date(T0 - 60_000).toISOString(), ready: 'wip', notes: [], changed: ['src/shared.ts'], changedTotal: 1, holds: [], ...over,
})

const buildHold = { resource: 'build', since: new Date(T0 - 120_000).toISOString(), how: 'command', command: 'npm run build', files: [], filesTotal: 0 }

const baseFiles = (extra: Record<string, string> = {}) => ({
  [`${SESSIONS}/1.json`]: registry('me-1', 'agent-me'),
  [`${SESSIONS}/2.json`]: registry('art-1', 'art'),
  [`${LIVE}/art-1.json`]: peerCard(),
  ...extra,
})

const own = (w: World) => JSON.parse(w.files.get(`${LIVE}/me-1.json`) ?? '{}')

test('start writes the card and the start note names the peer', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, baseFiles())
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  const card = own(w)
  expect(card.name).toBe('agent-me')
  expect(card.root).toBe(ROOT)
  const ctx = await $.prompt.context({ blocks: [] })
  const note = ctx.blocks.find(b => b.name === 'roster')?.text ?? ''
  expect(note).toContain('You are "agent-me"')
  expect(note).toContain('- art · busy · human 1m ago · work in progress · 1 changed file')
  expect(note.includes('Other machine')).toBe(false)
})

test("another OS user's live card is kept and listed, not deleted as dead", async ($, on) => {
  mock.clock(on, { now: T0 })
  const theirs = peerCard({ sessionId: 'agent-1', name: 'srv-deploy', configDir: '/home/agent/.claude', updatedAt: new Date(T0 - 90_000).toISOString() })
  const w = world(on, baseFiles({ [`${LIVE}/agent-1.json`]: theirs }))
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  expect(w.files.has(`${LIVE}/agent-1.json`)).toBe(true)
  const note = (await $.prompt.context({ blocks: [] })).blocks.find(b => b.name === 'roster')?.text ?? ''
  expect(note).toContain('- srv-deploy')
})

test('a machine in the user roster.json reaches the start note', async ($, on) => {
  mock.clock(on, { now: T0 })
  world(on, baseFiles({ [`${HOME}/.claude/roster.json`]: JSON.stringify({ machines: [{ desk: 'server-desk', workers: 'srv-', about: 'Ubuntu server' }] }) }))
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  const note = (await $.prompt.context({ blocks: [] })).blocks.find(b => b.name === 'roster')?.text ?? ''
  expect(note).toContain('Other machine (Ubuntu server): for work there, message "server-desk"')
})

test('a session in the project without the mod is still listed', async ($, on) => {
  mock.clock(on, { now: T0 })
  world(on, baseFiles({ [`${SESSIONS}/3.json`]: registry('plain-1', 'plain', native(`${ROOT}/sub`), 'idle'), [`${SESSIONS}/4.json`]: registry('far-1', 'far', native(ELSEWHERE)) }))
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  const note = (await $.prompt.context({ blocks: [] })).blocks.find(b => b.name === 'roster')?.text ?? ''
  expect(note).toContain('- plain · idle · no roster card')
  expect(note.includes('far')).toBe(false)
})

test('a dead card is cleaned up at start', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, baseFiles({ [`${LIVE}/gone-1.json`]: peerCard({ sessionId: 'gone-1', name: 'gone', updatedAt: new Date(T0 - 600_000).toISOString() }) }))
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  expect(w.files.has(`${LIVE}/gone-1.json`)).toBe(false)
  expect(w.files.has(`${LIVE}/art-1.json`)).toBe(true)
})

test('editing a file a peer also changed adds one heads-up, once', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, baseFiles(), ' M src/shared.ts\0')
  on('tool.call', () => ({ result: { type: 'update' } }))
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  const first = await $.tool.call({ tool: 'Edit', file_path: native(`${ROOT}/src/shared.ts`), old_string: 'a', new_string: 'b' })
  expect((first.context ?? []).join('\n')).toContain('art also has uncommitted changes in src/shared.ts')
  const second = await $.tool.call({ tool: 'Edit', file_path: native(`${ROOT}/src/shared.ts`), old_string: 'b', new_string: 'c' })
  expect((second.context ?? []).join('\n').includes('also has uncommitted')).toBe(false)
  await $.tool.call({ tool: 'mcp__roster__board' })
  expect(own(w).changed).toEqual(['src/shared.ts'])
})

test('a held resource pauses once, then the same command runs and is recorded', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, baseFiles({
    [`${LIVE}/art-1.json`]: peerCard({ holds: [buildHold] }),
    [`${ROOT}/.claude/roster.json`]: JSON.stringify({ holds: { build: ['npm run build'] } }),
  }), ' M src/a.ts\0')
  let ran = 0
  on('tool.call', () => { ran++; return { result: { stdout: 'ok', stderr: '', interrupted: false } } })
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })

  const first = await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(ran).toBe(0)
  expect(first.text ?? first.deny ?? '').toContain('build is held by art')

  const second = await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(ran).toBe(1)
  expect((second.context ?? []).join('\n')).toContain('This ran alongside it.')

  const run = JSON.parse(w.files.get(`${LIVE}/runs/build.json`) ?? '{}')
  expect(run.by).toBe('agent-me')
  expect(run.ok).toBe(true)
  expect(run.files).toEqual(['src/a.ts'])
  expect(own(w).holds).toEqual([])
})

test('a free resource is held while its command runs', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, baseFiles({ [`${ROOT}/.claude/roster.json`]: JSON.stringify({ holds: { deploy: ['deploy.sh'] } }) }))
  let seen: unknown[] = []
  on('tool.call', () => { seen = own(w).holds; return { result: { stdout: '', stderr: '', interrupted: false } } })
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  await $.tool.call({ tool: 'Bash', command: './deploy.sh prod' })
  expect((seen[0] as { resource: string }).resource).toBe('deploy')
  expect(own(w).holds).toEqual([])
})

test('a background run keeps its hold until released', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, baseFiles({ [`${ROOT}/.claude/roster.json`]: JSON.stringify({ holds: { server: ['npm run dev'] } }) }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }))
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  const r = await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  expect((r.context ?? []).join('\n')).toContain('mcp__roster__release')
  expect(own(w).holds[0].how).toBe('background')
  const released = await $.tool.call({ tool: 'mcp__roster__release', resource: 'server' })
  expect(String(released.result)).toContain('released server')
  expect(own(w).holds).toEqual([])
  expect(w.files.has(`${LIVE}/runs/server.json`)).toBe(true)
})

test('a peer freeing a hold reaches this session on its next tool call', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, baseFiles({ [`${LIVE}/art-1.json`]: peerCard({ holds: [buildHold] }) }))
  on('tool.call', () => ({ result: 'x' }))
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  w.files.set(`${LIVE}/art-1.json`, peerCard({ holds: [], updatedAt: new Date(T0 + 20_000).toISOString() }))
  await clock.advance(30_000)
  const r = await $.tool.call({ tool: 'Read', file_path: native(`${ROOT}/x.ts`) })
  expect((r.context ?? []).join('\n')).toContain('roster: build is free (art released it).')
  const again = await $.tool.call({ tool: 'Read', file_path: native(`${ROOT}/x.ts`) })
  expect(again.context ?? []).toEqual([])
})

test('update sets ready and notes; hold and release mark a resource', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, baseFiles())
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  const u = await $.tool.call({ tool: 'mcp__roster__update', ready: 'ready', notes: ['renamed Foo to Bar'] })
  expect(String(u.result)).toContain('marked ready to ship')
  expect(own(w).ready).toBe('ready')
  expect(own(w).notes).toEqual(['renamed Foo to Bar'])
  const bad = await $.tool.call({ tool: 'mcp__roster__hold', resource: 'no spaces' })
  expect(String(bad.result)).toContain('name the resource')
  await $.tool.call({ tool: 'mcp__roster__hold', resource: 'game', note: 'play-testing' })
  expect(own(w).holds[0].note).toBe('play-testing')
  const board = await $.tool.call({ tool: 'mcp__roster__board' })
  expect(String(board.result)).toContain('agent-me (you)')
  expect(String(board.result)).toContain('holds game')
})

test('the human typing is recorded; a peer message is not', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on, baseFiles())
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'peer' } })
  await $.tool.call({ tool: 'mcp__roster__board' })
  expect(own(w).humanAt).toBe(null)
  await clock.advance(1000)
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'mcp__roster__board' })
  expect(own(w).humanAt).toBe(new Date(T0 + 1000).toISOString())
})

test('closing the session removes its card and frees its holds', async ($, on) => {
  mock.clock(on, { now: T0 })
  const w = world(on, baseFiles())
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await $.session.start({ cwd: native(ROOT), surface: null, isInteractive: false })
  await $.tool.call({ tool: 'mcp__roster__hold', resource: 'deploy' })
  await $.session.end({ reason: 'other', sessionId: 'me-1', resume: { sessionId: 'me-1' } as never })
  expect(w.files.has(`${LIVE}/me-1.json`)).toBe(false)
  expect(JSON.parse(w.files.get(`${LIVE}/runs/deploy.json`) ?? '{}').resource).toBe('deploy')
})
