# pi-jobs

[![pi-jobs — for PI Agent](https://raw.githubusercontent.com/prjct-app/pi-local-extensions/main/pi-jobs/docs/cover-v2.png)](https://pi.dev)

Background jobs for Pi. A job keeps work running while you and the agent do other things, and wakes the agent when that work needs it. Wakes wait until the agent is idle, so they never interrupt a turn.

Jobs belong to the session. Ending the session kills their processes and deletes their logs.


## Install

Requires Pi and Node.js 22.19+. Install the package, then reload Pi:

```sh
pi install npm:@prjct.app/pi-jobs
```

## What a job is made of

| Part | What it is for | Example |
| --- | --- | --- |
| `command` | Runs something in the background: a dev server, or a long build or test run. When it exits, the agent is woken with the exit code and the last output. | `npm run dev` |
| `match` | Wakes the agent as soon as a new output line matches. The agent gets that line and the 5 after it, which is usually the stack trace. At most one wake every 30s per job; lines that match in between arrive together. | `error\|exception\|failed` |
| `every` | Wakes the agent on an interval (1m minimum) with the new output. For a job that reads output, a check is skipped when nothing new was printed. | `5m` |
| `follow` | Reads another job's output instead of running a command. This makes a watcher you can pause, edit or delete without touching the server. | `j1` |
| `check` | What the agent does when woken, in plain words. It is not a shell command. | `Find the cause and fix it.` |
| `max checks` | Ends the checks after this many wakes. A reminder or watcher then ends; a command keeps running. | `12` |

Every job does one of three things:
- runs a command;
- follows another job (with `match`, `every`, or both);
- or is a plain reminder: `every` plus `check`, with no command.

## Recipes

**Run a dev server.** Give it only a command. If it crashes, the agent hears about it. Nothing else wakes the agent.

```
command  npm run dev
```

**Watch its errors in a second job.** Select the server in `/jobs` and press `w`, or run `/jobs watch j1`. A form opens, already filled in:

```
follow  j1
match   error|exception|fatal|panic|traceback|unhandled|failed|ERR!
check   Read the error and the lines after it. Find the cause and fix it if it is in this project; otherwise say what is wrong.
```

Each time the server prints an error, the agent gets the error and the lines after it, and goes to fix it. While you break things on purpose, pause the watcher with `p`; the server keeps running.

**Review its logs every so often.**

```
follow  j1
every   10m
check   Anything unusual in these logs? Say so only if there is.
```

If the server printed nothing in those 10 minutes, the check is skipped.

**Wait on a deploy or a CI run.** A reminder with no command:

```
every       5m
check       Is the staging deploy green? Tell me when it is, then stop this job.
max checks  12
```

**Run tests you don't want to wait for.** Give only the command (`npm test`). The agent hears the result when the tests end. Don't add `every`.

**Restart a server after changing env or config.** Use one of these:
- press `r` in `/jobs`;
- run `/jobs restart j1`;
- the agent calls `job_restart`.

The job keeps its id, and its watchers keep following it. The old process exits completely before the new one starts, so the port is free.

## /jobs

`/jobs` opens the docked panel. The list is on the left. The detail is on the right: state, command, what it follows and what follows it, match, wakes, matched lines not yet reported, output and history.

| Key | Action | Shown when |
| --- | --- | --- |
| `n` | New job, in the form. | always |
| `w` | Watch errors: a new watcher that follows this job, filled in as above. | the job runs a command |
| `c` | Check now: the agent is woken about it at its next idle moment. | active |
| `p` | Pause or resume checks and matches. The process keeps running, and an exit is still reported. | active, with `every` or `match` |
| `e` | Edit. Name, match, every, check and max checks change without touching the process. Changing command, cwd or follow restarts the job. On a finished job: edit, then run it again. | any job |
| `r` | Restart (on a finished job: run again) under the same id. | any job · asks again |
| `x` | Stop: SIGTERM to its process group, then SIGKILL after 3s. The jobs that follow it stop too. The job stays in the list. | active · asks again |
| `d` | Delete: stop the job and remove it along with its log. Its watchers stop. | any job · asks again |
| `D` | Purge finished: delete every finished job the agent has already heard about. A finished job that an active watcher still follows is kept. | there is one · asks again |
| `X` | Stop all. | 2+ active · asks again |

`/` searches and `?` lists every key. `esc` goes back, clears the search, or closes the panel.

These commands also work outside the TUI and complete job ids:

```
/jobs new              /jobs restart <id>
/jobs watch <id>       /jobs stop <id|all>
/jobs check <id>       /jobs delete <id>
/jobs pause <id>       /jobs purge
/jobs resume <id>      /jobs help
```

## For the agent

The agent has four tools: `job_start`, `job_status`, `job_restart` and `job_stop`. Their descriptions steer it away from the ways jobs waste turns:
- A server gets no `every`. A crash wakes the agent anyway, and errors are `match`'s job.
- A command gets no `every` just to learn that it finished.
- `check` is plain words, not a shell command.
- One job per command. Starting a command that an active job already runs is refused, and the message names that job so the agent restarts it instead.

## Limits

- `every` is at least 1m. Each wake is a full turn of the model.
- `match` wakes the agent at most once every 30s per job.
- At most 10 active jobs per session.
- Several jobs due at the same moment arrive as one message.
- While any job is active, the mode line shows `jobs N`.
- Logs live in the OS temp dir under `pi-jobs/`. They are deleted with the job or with the session.

Build from `local-extensions`: `node scripts/build-pi.mjs pi-jobs` (or `~/Apps/pi/install-local.sh local-extensions`). Tests: `npm test` here.

License: [MIT](LICENSE).
