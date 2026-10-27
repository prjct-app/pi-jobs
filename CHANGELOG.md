# Changelog

## Unreleased

- `job_status` renders as one line: how the job ended or what it is doing, with its run and line count. Expanding shows the command (clipped), the cwd and log, and the output tail. The call row names the job instead of its id. The model still receives the full status text.

## 0.1.5 — 2026-10-13

- The manager keeps everything it knows (jobs, process and log handles, partial lines, patterns, flags) in one immutable book that is replaced on every change.
- A job handed out by `start`, `stop`, `restart`, `due`, etc. never changes afterwards; the newest value comes from `get(id)`.
- Output capture is a pure function, `takeLines`. Output that arrives after a job was deleted is now dropped instead of being written into a detached object.

## 0.1.4 — 2026-10-12

- Code: no `let` bindings; mutable state lives in one named object. Behaviour is unchanged.
- Tests run with temporary Pi and prjct folders, so they never touch your real configuration.

## 0.1.3 — 2026-10-11

- `job_status` returns `{ jobs, output? }` to codemode scripts through `outputSchema` and `structuredContent`; the model still reads the same text.

## 0.1.2 — 2026-10-06

- Publish from an independent repository with its own checks, lockfile and declared npm dependencies. Preserve the extension history and install name.
