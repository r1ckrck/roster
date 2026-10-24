# roster

A Claude Code mod for several agents working in one folder. Each agent can see who else is there, what they have changed and not yet committed, and which shared resources (a build, a deploy, a dev server) they hold, so it can look things up instead of asking. Talking stays with Claude Code's own peer messaging (`/peers`, SendMessage).

Nothing is ever blocked except one optional pause, and no file is ever locked.

## Install

```
/plugin install roster --marketplace r1ckrck/roster
```

Answer `y` to add the marketplace, then choose the **user** scope. It is then on in every session on that machine, in every folder: at once in the session you install from, and in other open sessions once they restart.

Update with `claude plugin update roster`, then `/reload-plugins` in open sessions.

Needs Claude Code 2.1.296 or later (the mod API is early access). Peer messaging needs 2.1.224 on macOS and 2.1.234 on Windows.

**Keep the cards out of git:** add `.claude/live/` to the project's `.gitignore`, or `**/.claude/live/` to your global ignore file (`~/.config/git/ignore`) to cover every repo at once. roster never edits your files; it says once per project if git would pick the cards up.

## What it does

| When | roster |
|---|---|
| A session opens | Writes its card in `<project>/.claude/live/<session-id>.json` and gives the agent a short note: its name, where the cards are, one line per agent already there. |
| The agent edits a file | Adds it to the card's changed files. Committed files drop off, whoever commits them. |
| The agent edits a file a peer has also changed | Adds one line after the edit, once per file and peer. Both can keep editing. |
| A command needs a resource a peer holds | Pauses it once with the holder's name and how long they have had it. Running the same command again goes ahead (see Settings). |
| A command holds a resource | Marks the hold on the card while it runs, then records the run in `runs/<resource>.json`: who, when, whether it worked, which changed files went in. |
| A peer joins, leaves, takes or frees a hold | One line on the agent's next tool call or prompt. Nothing else interrupts. |
| The session closes | Deletes its card and frees its holds. A crashed session's card is removed by the next session that looks. |

"The project" is the git repository (its main working tree), or the folder itself outside git. Sessions in the project without roster still show, just without a card.

## Cards

One small JSON file per live agent, overwritten in place, never appended:

```json
{
  "name": "transfer",
  "status": "busy",
  "humanAt": "2026-10-21T14:02:11.000Z",
  "ready": "wip",
  "changed": ["src/Patches/Transfer.cs", "input/rules.json"],
  "holds": [{ "resource": "build", "since": "2026-10-21T14:02:30.000Z", "how": "command", "command": "Build-All.ps1", "files": ["..."], "filesTotal": 2 }],
  "notes": ["FcKey gained TransferRate; rebuild before testing"]
}
```

`humanAt` is when the session's human last typed, so a peer can judge whether a question will be answered. `status` and `name` come from Claude Code's own session list, so `/rename` shows up within half a minute.

## Shared resources

A resource is held either by a command matching a pattern, or by the agent through a tool. Patterns live in `roster.json`, in the user's Claude folder (`~/.claude/roster.json`) for every project, and in `<project>/.claude/roster.json` for one. The project's entry for a resource replaces the user's.

```json
{ "holds": { "build": ["npm run build", "Build-All"], "deploy": ["Deploy-Module", "fly deploy"] } }
```

A pattern matches when it appears anywhere in a Bash or PowerShell command, ignoring case. A command run in the background keeps its hold until the agent releases it.

## For agents

The start note is all an agent needs; these tools are listed in it and load through ToolSearch:

| Tool | Does |
|---|---|
| `mcp__roster__board` | Everyone in the project at a glance, with changed files, holds, notes and the last runs. |
| `mcp__roster__hold` / `mcp__roster__release` | Holds or frees a resource no pattern covers, such as a running app being play-tested. |
| `mcp__roster__update` | Sets ready or work in progress, and up to ten short notes for peers. |

`/roster` shows the same board to you.

## Settings

One, in `/config` under roster:

| Setting | Values |
|---|---|
| When a command needs a resource a peer holds | `pause` (default): stop it once with a note; running it again goes ahead. `warn`: run it and add the note after. |

## Limits

- Files changed by shell commands (`sed`, a generator) are not tracked; only the Edit, Write and NotebookEdit tools are.
- One machine only: cards are files, and liveness comes from Claude Code's local session list (`~/.claude/sessions`). That list belongs to Claude Code and may change; roster then falls back to each card's own heartbeat, and a dead card lingers up to ten minutes.
- Outside git, changed files are the agent's latest edits rather than uncommitted ones.
- Several OS users can share a folder: each card names the Claude folder it came from, and a card from another user's Claude folder goes by its heartbeat, since that user's sessions are not in this one's list.

## Other machines

roster sees one machine. For agents on your other machines, use Claude Code's own messaging over Remote Control:

1. Turn on Remote Control on every machine: `/config` → **Enable Remote Control for all sessions**. On a server, keep a session running with `claude remote-control --name <name>` (in tmux or a service).
2. Sessions on other machines then show in `/peers` (ListAgents), labelled `Remote Control`. They have no card and are never on the board.
3. Name that session the machine's **desk** in `~/.claude/roster.json` on each machine that sends:

   ```json
   { "machines": [{ "desk": "<desk name>", "workers": "<worker prefix>", "about": "<what the machine is for>" }] }
   ```

   Each entry adds one line to the start note: for work there, message the desk; if the desk starts workers named `<prefix><task>`, message the worker directly. A worker closes itself after its report, unless the request says the work takes several exchanges; then keep using it and say when the whole task is done. `workers` and `about` are optional, up to three machines are read, and a project's `machines` list replaces the user's.

How the desk starts and closes workers is up to that machine; roster only tells agents how to reach it. A ready-made desk for a Linux server, with named workers that close themselves, is in [`server/`](server/README.md).

Messages between machines pass through Anthropic's servers and need a claude.ai sign-in; messages on one machine never leave it. They are text only: push files to git first.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`hooks/core.ts` is the pure logic, `hooks/register.ts` the hooks and I/O; `tests/` covers both against an in-memory filesystem, faking a machine of the host's kind (Windows, or macOS and Linux). `server/` is the optional server desk and is not part of the plugin.

## License

GPL-3.0. See [LICENSE](LICENSE).
