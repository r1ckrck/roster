# Server desk

An optional setup for a Linux server that agents on your other machines can hand work to. One long-running Claude session, the **desk**, takes requests over Claude Code's own messaging and starts a named **worker** for each task. The asking agent then talks to the worker directly. Workers close themselves when the task is done, and a timer closes the ones that are finished, dead or idle.

```
laptop agent ──SendMessage──▶ server-desk ──srv-spawn──▶ srv-<task> (tmux)
     ▲                                                        │
     └───────────────────── reports, follow-ups ──────────────┘
```

roster itself doesn't need any of this; it only tells agents on your other machines how to reach the desk (see [Other machines](../README.md#other-machines)).

## Requirements

- Linux with systemd (the scripts read `/proc`).
- Claude Code, signed in with a claude.ai subscription (Pro, Max, Team or Enterprise). Remote Control does not work with an API key.
- tmux 3.0 or later, python3, bash, coreutils, awk and sed.
- Root access, once, for the user and the service.

## Setup

The examples use the user `agent`, the work folder `/opt/desk` and the desk name `server-desk`. Change them to taste; the scripts read them from settings (step 4).

**1. A user for the agents.** A separate user with no sudo keeps the agents' reach to what you give it.

```
sudo useradd -m -s /bin/bash agent
sudo mkdir -p /opt/desk && sudo chown agent: /opt/desk
sudo loginctl enable-linger agent        # user timers run with nobody logged in
```

**2. Claude Code as that user.** Log in as `agent` (`sudo -iu agent`), install Claude Code, then:

- `claude auth login` and pick the claude.ai option.
- In `/opt/desk`, run `claude remote-control --spawn same-dir` once, answer `y` to **Enable Remote Control?**, then Ctrl+C. The service has no terminal to answer that question.
- In `~/.claude/settings.json`: `"permissions": { "defaultMode": "auto" }`. Auto mode only takes effect in the user's settings, not a project's.
- Run `claude` once in `/opt/desk` and accept the trust prompt. A worker can't answer that prompt, so `srv-spawn` refuses folders that aren't trusted. Trusting a folder covers everything below it, so trust the top folder you want workers in.
- To let workers reach other folders too, add them to `"permissions": { "additionalDirectories": [...] }`, and trust them the same way.

**3. This repo**, as `agent`:

```
git clone https://github.com/r1ckrck/roster.git ~/roster
```

**4. Settings (optional).** Defaults live in `server/bin/lib.sh`. To change any, create `~/.config/srv/env`:

```
SRV_DESK=server-desk      # the desk's session name, the default requester
SRV_DIR=/opt/desk         # where a worker starts when no folder is given
SRV_MAX=3                 # workers at once
SRV_IDLE_MAX=14400        # close after 4h idle (seconds)
SRV_HARD_MAX=86400        # close after 24h no matter what
```

**5. The desk service.** Edit `server/systemd/claude-desk.service` (user, folder, claude path, `--name`), then:

```
sudo cp ~agent/roster/server/systemd/claude-desk.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now claude-desk
```

The service's start-up session is the desk. It shows in `/peers` on your other machines under its `--name`. Sessions on the server itself see a generated name instead until you rename it once: open the desk in the Claude app and type `/rename server-desk`. The name then holds across restarts.

**6. The reap timer**, as `agent`:

```
mkdir -p ~/.config/systemd/user
cp ~/roster/server/systemd/srv-reap.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now srv-reap.timer
systemctl --user list-timers | grep srv-reap
```

If `systemctl --user` fails with "Failed to connect to bus", the shell inherited another user's session (common after `su` or from a Claude shell). Run it as `env -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user ...`.

**7. The rules.** Append [`CLAUDE.md.example`](CLAUDE.md.example) to `~agent/.claude/CLAUDE.md`, with your paths and desk name. Then restart the desk (`sudo systemctl restart claude-desk`) so it reads them.

**8. Your other machines.** Turn on Remote Control on each (`/config` → **Enable Remote Control for all sessions**), install roster, and name the desk in `~/.claude/roster.json`:

```json
{ "machines": [{ "desk": "server-desk", "workers": "srv-", "about": "Linux server" }] }
```

**9. Try it.** From another machine, ask an agent to have `server-desk` start a worker that reports the server's uptime. The desk replies with the worker's name, the worker reports back, and within five minutes of finishing it is gone from `/peers`.

## How it works

| Script | Does |
|---|---|
| `srv-spawn <task> [dir] "<brief>" [--from <peer>] [--multi]` | Starts `claude --name srv-<task> --remote-control srv-<task> --permission-mode auto` in tmux (`-L srv`), with a brief naming the worker, its task, its requester and how to finish. Records it in `~/.local/state/srv/`. Exits 0 started, 2 usage, 3 already running (prints the name to reuse), 4 at capacity, 5 folder not trusted, 6 failed to start, checked in that order. |
| `srv-done` | Run by a worker when its whole task is done. Marks its record; it can't close its own session, since auto mode blocks an agent from killing a job it didn't start. |
| `srv-reap` | Run by the timer. Closes recorded workers that are done, gone, dead, older than `SRV_HARD_MAX`, or idle longer than `SRV_IDLE_MAX`, then clears their records. It only acts on records, so sessions it didn't start are never touched. |
| `srv-list` | Recorded workers: name, live/dead/done, status, idle seconds, requester, folder. |

A one-off worker reports once and closes. With `--multi`, which the desk adds when a request says the work takes several exchanges, the worker stays for follow-ups until the requester says the whole task is done.

Logs: `~/.local/state/srv/srv.log`.

## Good to know

- **The desk resumes its session.** On every restart, `claude remote-control` resumes the session it last recorded for the folder (`~/.claude/projects/<folder>/bridge-pointer.json`), so changing `--name` doesn't rename it. Rename it with `/rename` from the Claude app, which also changes the name agents on the server see. For a fresh desk: stop the service, move that pointer file aside, start it.
- **"This folder is already served…"** can stop the first start after a fresh desk. It clears itself within about a minute; `Restart=on-failure` brings it up.
- **A restart of the desk service usually closes every worker**: the desk normally starts the workers' tmux server, so it runs under the service. Start more afterwards.
- **Running sessions keep their old version and rules.** A long-running desk keeps its Claude Code binary, plugins and CLAUDE.md until restarted. `/reload-plugins` isn't available over Remote Control, so restart the service.
- **Group changes** reach the desk and workers only after a restart.
- **A worker can't see its own name**, so the brief tells it, and `srv-done` finds its record through `SRV_NAME`, which tmux sets.

## Safety

- Agents in auto mode act without asking. Auto mode still stops for actions it judges risky, and those wait for you in the Claude app.
- Messages between machines, and the transcripts of sessions with Remote Control on, pass through Anthropic's servers.
- A message from another session can't approve a permission prompt or change settings; the receiving session's own rules apply.
- Keep the agent user unprivileged and give it only the folders it needs.
