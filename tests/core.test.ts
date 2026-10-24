import { describe, expect, test } from 'claude-code/testing'
import {
  age, capNotes, diffNotices, drainNotices, holdWarning, isCardLive, isCardRemovable, isDirty, isInside, listFor,
  labels, machineLine, matchHolds, mergeConfig, normPath, parseCard, parseConfig, parseGitStatus, parseRegistryEntry,
  peerLine, relPath, renderBoard, renderStartNote, snapshot,
} from '../hooks/core.ts'
import type { Card, Peer } from '../hooks/core.ts'

const NOW = Date.parse('2026-10-21T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

function card(over: Partial<Card> = {}): Card {
  return {
    roster: 1, sessionId: 'aaaaaaaa-1', configDir: 'C:/Users/me/.claude', name: 'art', root: 'C:/p', cwd: 'C:/p', status: 'busy',
    startedAt: ago(3_600_000), updatedAt: ago(5_000), humanAt: ago(120_000), ready: null,
    notes: [], changed: [], changedTotal: 0, holds: [], ...over,
  }
}
const peer = (c: Card): Peer => ({ sessionId: c.sessionId, name: c.name, status: c.status, card: c })

describe('paths', () => {
  test('normalises separators and trailing slashes', () => {
    expect(normPath('C:\\Program Files (x86)\\Mount & Blade\\')).toBe('C:/Program Files (x86)/Mount & Blade')
    expect(normPath('C:/')).toBe('C:/')
    expect(normPath('/')).toBe('/')
    expect(normPath('/Users/me/proj/')).toBe('/Users/me/proj')
  })
  test('compares Windows paths without case, macOS paths with it', () => {
    expect(isInside('c:\\proj\\src\\a.ts', 'C:/Proj', true)).toBe(true)
    expect(isInside('/Users/me/Proj/a.ts', '/Users/me/proj', false)).toBe(false)
    expect(isInside('C:/projector/a', 'C:/proj', true)).toBe(false)
    expect(isInside('C:/proj', 'C:/proj', true)).toBe(true)
  })
  test('gives paths relative to the root, or null outside it', () => {
    expect(relPath('C:\\proj\\src\\a.ts', 'C:/proj', true)).toBe('src/a.ts')
    expect(relPath('/Users/me/proj/src/a.ts', '/Users/me/proj', false)).toBe('src/a.ts')
    expect(relPath('/Users/me/other/a.ts', '/Users/me/proj', false)).toBe(null)
    expect(relPath('C:/proj', 'C:/proj', true)).toBe(null)
  })
})

describe('git status', () => {
  test('reads modified, untracked and renamed entries', () => {
    const z = ' M src/a.ts\0?? notes/\0R  new name.ts\0old name.ts\0A  b.ts\0'
    expect(parseGitStatus(z)).toEqual(['src/a.ts', 'notes/', 'new name.ts', 'b.ts'])
    expect(parseGitStatus('')).toEqual([])
  })
  test('counts a file under an untracked folder as dirty', () => {
    const dirty = ['src/a.ts', 'notes/']
    expect(isDirty('src/a.ts', dirty, false)).toBe(true)
    expect(isDirty('notes/today.md', dirty, false)).toBe(true)
    expect(isDirty('src/b.ts', dirty, false)).toBe(false)
    expect(isDirty('SRC/A.ts', dirty, true)).toBe(true)
    expect(isDirty('SRC/A.ts', dirty, false)).toBe(false)
  })
})

describe('config', () => {
  test('keeps valid resources and patterns, drops the rest', () => {
    const c = parseConfig(JSON.stringify({ holds: { build: ['npm run build', 3, ''], 'bad name!': ['x'], deploy: 'no' } }))
    expect(c).toEqual({ holds: { build: ['npm run build'] }, machines: [] })
    expect(parseConfig('not json')).toEqual({ holds: {}, machines: [] })
    expect(parseConfig(undefined)).toEqual({ holds: {}, machines: [] })
  })
  test('keeps machines with a valid desk, drops the rest, caps the list', () => {
    const c = parseConfig(JSON.stringify({
      machines: [
        { desk: 'server-desk', workers: 'srv-', about: '  Ubuntu server  ' },
        { desk: 'bad desk!' },
        { workers: 'srv-' },
        { desk: 'pc-desk', workers: 'bad prefix!', about: 7 },
        'nope', null, { desk: 'third' }, { desk: 'fourth' },
      ],
    }))
    expect(c.machines).toEqual([
      { desk: 'server-desk', workers: 'srv-', about: 'Ubuntu server' },
      { desk: 'pc-desk', workers: '', about: '' },
      { desk: 'third', workers: '', about: '' },
    ])
    expect(parseConfig(JSON.stringify({ machines: Array.from({ length: 5 }, (_, i) => ({ desk: `d${i}` })) })).machines.length).toBe(3)
  })
  test('the project file wins resource by resource, and its machines replace the user list', () => {
    const desk = { desk: 'server-desk', workers: 'srv-', about: '' }
    const merged = mergeConfig({ holds: { build: ['make'], test: ['npm test'] }, machines: [desk] }, { holds: { build: ['Build-All'] }, machines: [] })
    expect(merged).toEqual({ holds: { build: ['Build-All'], test: ['npm test'] }, machines: [desk] })
    const other = { desk: 'other-desk', workers: '', about: '' }
    expect(mergeConfig({ holds: {}, machines: [desk] }, { holds: {}, machines: [other] }).machines).toEqual([other])
  })
  test('matches commands case-insensitively, several resources at once', () => {
    const c = { holds: { build: ['build-all'], deploy: ['Deploy-Module'] }, machines: [] }
    expect(matchHolds('& tools\\Build-All.ps1; tools\\Deploy-Module.ps1 -Build', c)).toEqual(['build', 'deploy'])
    expect(matchHolds('git status', c)).toEqual([])
  })
})

describe('cards', () => {
  test('parses a card and fills what is missing', () => {
    const c = parseCard(JSON.stringify({ sessionId: 's1', name: 'art', ready: 'maybe', notes: ['a', 3] }))
    expect(c?.ready).toBe(null)
    expect(c?.notes).toEqual(['a'])
    expect(c?.holds).toEqual([])
    expect(parseCard('')).toBe(null)
    expect(parseCard('{"name":"x"}')).toBe(null)
  })
  test('reads the engine session list', () => {
    expect(parseRegistryEntry('{"sessionId":"abc","name":"agent1","cwd":"C:\\\\p","status":"idle"}')).toEqual({ sessionId: 'abc', name: 'agent1', cwd: 'C:\\p', status: 'idle' })
    expect(parseRegistryEntry('{"pid":1}')).toBe(null)
  })
  test('caps notes at ten short lines', () => {
    const notes = capNotes([...Array.from({ length: 12 }, (_, i) => `note ${i}`), '  ', 'x'.repeat(300)])
    expect(notes.length).toBe(10)
    expect(capNotes(['x'.repeat(300)])[0]?.length).toBe(200)
    expect(capNotes(['  a \n b  '])).toEqual(['a b'])
  })
})

describe('liveness', () => {
  const live = new Set(['aaaaaaaa-1'])
  test('the session list decides when it can be read', () => {
    expect(isCardLive(card(), live, NOW)).toBe(true)
    expect(isCardLive(card({ sessionId: 'gone', updatedAt: ago(5 * 60_000) }), live, NOW)).toBe(false)
    expect(isCardLive(card({ sessionId: 'new', updatedAt: ago(10_000) }), live, NOW)).toBe(true)
  })
  test('the heartbeat decides without it', () => {
    expect(isCardLive(card({ updatedAt: ago(60_000) }), null, NOW)).toBe(true)
    expect(isCardLive(card({ updatedAt: ago(4 * 60_000) }), null, NOW)).toBe(false)
  })
  test('dead cards are removed, at once with the list and after ten minutes without it', () => {
    const dead = card({ sessionId: 'gone', updatedAt: ago(5 * 60_000) })
    expect(isCardRemovable(dead, 0, live, NOW)).toBe(true)
    expect(isCardRemovable(dead, 0, null, NOW)).toBe(false)
    expect(isCardRemovable(card({ updatedAt: ago(11 * 60_000) }), 0, null, NOW)).toBe(true)
    expect(isCardRemovable(card(), 0, live, NOW)).toBe(false)
    expect(isCardRemovable(null, NOW - 120_000, live, NOW)).toBe(true)
    expect(isCardRemovable(null, NOW - 10_000, live, NOW)).toBe(false)
  })
  test('a card from another Claude folder is judged by its heartbeat, not our list', () => {
    const mine = 'C:/Users/me/.claude'
    expect(listFor(card(), mine, live, true)).toBe(live)
    expect(listFor(card({ configDir: 'c:\\users\\ME\\.claude' }), mine, live, true)).toBe(live)
    expect(listFor(card({ configDir: '/home/agent/.claude' }), '/home/me/.claude', live, false)).toBe(null)
    expect(listFor(card({ configDir: '' }), mine, live, true)).toBe(null)
    // Another user's running session: missing from our list, fresh heartbeat, so kept.
    const theirs = card({ sessionId: 'other-user', configDir: '/home/agent/.claude', updatedAt: ago(30_000) })
    const ids = listFor(theirs, '/home/me/.claude', live, false)
    expect(isCardLive(theirs, ids, NOW)).toBe(true)
    expect(isCardRemovable(theirs, 0, ids, NOW)).toBe(false)
  })
})

describe('text', () => {
  test('ages read short', () => {
    expect(age(12_000)).toBe('12s')
    expect(age(3 * 60_000)).toBe('3m')
    expect(age(5 * 3_600_000)).toBe('5h')
    expect(age(3 * 86_400_000)).toBe('3d')
  })
  test('agents that share a name get their id', () => {
    const l = labels([{ sessionId: 'aaaaaa11', name: 'art' }, { sessionId: 'bbbbbb22', name: 'art' }, { sessionId: 'c', name: 'ui' }])
    expect(l.get('aaaaaa11')).toBe('art (aaaaaa)')
    expect(l.get('c')).toBe('ui')
  })
  test('a peer line says status, human, ready, holds and changes', () => {
    const c = card({ ready: 'wip', changedTotal: 2, holds: [{ resource: 'build', since: ago(600_000), how: 'command', command: 'npm run build', files: [], filesTotal: 2 }] })
    expect(peerLine(peer(c), 'art', NOW)).toBe('art · busy · human 2m ago · work in progress · holds build for 10m (npm run build) · 2 changed files')
    expect(peerLine({ sessionId: 'x', name: 'old', status: 'idle', card: null }, 'old', NOW)).toBe('old · idle · no roster card')
  })
  test('the start note stays short and points at the cards and tools', () => {
    const peers = Array.from({ length: 8 }, (_, i) => peer(card({ sessionId: `s${i}`, name: `agent${i}` })))
    const note = renderStartNote({ name: 'me', liveDir: 'C:/p/.claude/live' }, peers, NOW)
    expect(note.split('\n').length <= 10).toBe(true)
    expect(note).toContain('You are "me"')
    expect(note).toContain('C:/p/.claude/live/')
    expect(note).toContain('and 4 more')
    expect(note).toContain('mcp__roster__board')
    expect(renderStartNote({ name: 'me', liveDir: 'd' }, [], NOW)).toContain('No other agents are here now.')
  })
  test('the start note gains one line per configured machine and is unchanged without one', () => {
    const plain = renderStartNote({ name: 'me', liveDir: 'd' }, [], NOW)
    expect(renderStartNote({ name: 'me', liveDir: 'd' }, [], NOW, [])).toBe(plain)
    const withDesk = renderStartNote({ name: 'me', liveDir: 'd' }, [], NOW, [{ desk: 'server-desk', workers: 'srv-', about: 'Ubuntu server' }])
    expect(withDesk.startsWith(plain + '\n')).toBe(true)
    const line = withDesk.slice(plain.length + 1)
    expect(line.includes('\n')).toBe(false)
    expect(line).toContain('Other machine (Ubuntu server)')
    expect(line).toContain('message "server-desk"')
    expect(line).toContain('srv-<task>')
    expect(line).toContain('not reachable yet, list peers with ListAgents and retry')
    expect(line).toContain('closes itself after its report')
    expect(line).toContain('several exchanges')
    expect(line).toContain('whole task is done')
    expect(machineLine({ desk: 'pc-desk', workers: '', about: '' })).toBe('Other machine: for work there, message "pc-desk" (SendMessage). Tell it once the whole task is done, not after each step.')
  })
  test('the board lists everyone, their files, notes and the last runs', () => {
    const me = card({ sessionId: 'me', name: 'me', changed: ['a.ts'], changedTotal: 1 })
    const other = card({ notes: ['renamed X to Y'], changed: Array.from({ length: 10 }, (_, i) => `f${i}.ts`), changedTotal: 12 })
    const text = renderBoard({ card: me, liveDir: 'L' }, [peer(other)], [{
      resource: 'build', by: 'art', sessionId: 'aaaaaaaa-1', how: 'command', startedAt: ago(700_000), endedAt: ago(600_000), ok: true, files: [], filesTotal: 3,
    }], NOW)
    expect(text).toContain('me (you)')
    expect(text).toContain('(+4 more)')
    expect(text).toContain('note: renamed X to Y')
    expect(text).toContain('- build: art, ended 10m ago, ok, 3 changed files in')
  })
})

describe('notices', () => {
  const hold = (resource: string) => ({ resource, since: ago(1000), how: 'manual' as const, files: [], filesTotal: 0 })
  test('says joins, leaves, holds taken and freed, once each', () => {
    const before = snapshot([peer(card({ sessionId: 'a', name: 'art', holds: [hold('build')] })), peer(card({ sessionId: 'b', name: 'ui' }))])
    const after = snapshot([peer(card({ sessionId: 'a', name: 'art', holds: [hold('deploy')] })), peer(card({ sessionId: 'c', name: 'docs' }))])
    expect(diffNotices(before, after)).toEqual([
      'roster: art took deploy.',
      'roster: build is free (art released it).',
      'roster: docs joined.',
      'roster: ui left.',
    ])
    expect(diffNotices(after, after)).toEqual([])
  })
  test('drains at most six lines, deduplicated', () => {
    const q = ['a', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const text = drainNotices(q)
    expect(q.length).toBe(0)
    expect(text?.split('\n').length).toBe(7)
    expect(text).toContain('2 more changes')
    expect(drainNotices([])).toBe(null)
  })
  test('a hold warning names the holder and says what happens next', () => {
    const holder = peer(card({ name: 'art', holds: [{ resource: 'build', since: ago(120_000), how: 'command', command: 'make', files: [], filesTotal: 0 }] }))
    expect(holdWarning('build', [holder], NOW, 'pause')).toBe('roster: build is held by art for 2m (make). Nothing ran. Wait for it (you get a note when it is free), ask the holder, or run the same command again to go ahead anyway.')
    expect(holdWarning('build', [holder], NOW, 'warn')).toBe('roster: build is held by art for 2m (make). This ran alongside it.')
  })
})
