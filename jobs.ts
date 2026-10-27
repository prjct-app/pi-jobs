import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, openSync, rmSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

/** Waiting means a job without a process of its own: a reminder, or a watcher that follows another job. */
export type JobState = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export type JobSpec = {
  name: string;
  command?: string;
  cwd: string;
  /** Another job whose output this one reads instead of running a command. */
  follow?: string;
  /** Milliseconds between checks. */
  every?: number;
  /** Case-insensitive pattern: a new output line that matches wakes the agent. */
  match?: string;
  /** What the agent does when woken. */
  check?: string;
  maxChecks?: number;
  /** Who started it: the agent through job_start, or the person from /jobs. */
  origin?: 'agent' | 'person';
};

export type Job = Readonly<JobSpec & {
  id: string;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  logFile?: string;
  /** Times the agent was woken by a check or a match in this run. */
  checks: number;
  nextCheckAt?: number;
  /** Checks and matches are held; an exit is still reported. */
  paused: boolean;
  /** 1 for the first run; each restart adds one. */
  runs: number;
  /** Last lines of output, oldest first. */
  tail: readonly string[];
  /** Every line the job has written, including those no longer in `tail`. */
  lines: number;
  /** `lines` at the last report to the agent. */
  reported: number;
  /** An exit the agent has not been told about. */
  exitPending: boolean;
  /** Lines that matched, each with the lines after it, not yet reported. At most WAKE_LINES. */
  hits: readonly string[];
  /** Matching lines not yet reported, including those past the `hits` cap. */
  hitCount: number;
  /** Captured lines that did not fit in `hits`. */
  hitsOmitted: number;
  firstHitAt?: number;
  lastMatchAt?: number;
  /** Newest first. */
  history: readonly Readonly<{ at: number; text: string }>[];
}>;

/** One reason to wake the agent about one job. */
export type Wake = Readonly<{
  job: Job;
  reason: 'check' | 'match' | 'exit';
  /** Matching lines when there are any, otherwise the new lines since the last report. At most WAKE_LINES. */
  output: readonly string[];
  /** Lines not included in `output`. */
  omitted: number;
  /** Matching lines behind this wake; 0 when `output` is plain new output. */
  matched: number;
  /** The job a watcher follows. */
  source?: Pick<Job, 'id' | 'name' | 'logFile'>;
}>;

export const MAX_ACTIVE = 10;
/** Every wake is a full turn of the model, so checks are at most once a minute. */
export const MIN_EVERY = 60_000;
/** At most one wake per job for matching lines in this window; the rest wait for the next one. */
export const MATCH_GAP = 30_000;
/** A match waits this long for the lines that follow it, such as a stack trace. */
const SETTLE = 2_000;
/** Lines kept after a matching line. */
const CONTEXT = 5;
const TAIL = 400;
const WAKE_LINES = 40;
const LINE_CHARS = 400;
const KILL_GRACE = 3_000;
/** A restart gives up when the old process outlives SIGKILL by this much. */
const EXIT_WAIT = KILL_GRACE + 3_000;

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000 };

/** "30s", "5m", "1h30m" → milliseconds; undefined when it is not a duration. */
export function parseDuration(text: string): number | undefined {
  const clean = text.trim().toLowerCase();
  if (!/^(\d+\s*[smh]\s*)+$/.test(clean)) return undefined;
  const total = [...clean.matchAll(/(\d+)\s*([smh])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * UNITS[unit], 0);
  return total > 0 ? total : undefined;
}

/** 90_000 → "1m30s". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return [h && `${h}h`, m && `${m}m`, (s || (!h && !m)) && `${s}s`].filter(Boolean).join('');
}

export const isActive = (job: Pick<Job, 'state'>): boolean => job.state === 'running' || job.state === 'waiting';

/** True when the job reads output: its own command's, or the job it follows. */
const readsOutput = (job: Pick<JobSpec, 'command' | 'follow'>): boolean => !!(job.command || job.follow);

const exhausted = (job: Job): boolean => job.maxChecks !== undefined && job.checks >= job.maxChecks;

/** Why a spec cannot start, or undefined when it can. */
export function specError(spec: Pick<JobSpec, 'command' | 'follow' | 'every' | 'match' | 'check'>): string | undefined {
  if (spec.command && spec.follow) return 'A job either runs a command or follows another job, not both.';
  if (!spec.command && !spec.follow && !spec.every) return 'Give a command to run, a job to follow, or an interval to check on.';
  if (spec.follow && !spec.every && !spec.match) return 'A job that follows another needs match, every, or both.';
  if (!readsOutput(spec) && spec.match) return 'match reads output: give a command, or a job to follow.';
  if (!readsOutput(spec) && !spec.check) return 'A reminder without a command needs a check instruction.';
  if (spec.every !== undefined && spec.every < MIN_EVERY) return `Checks run at most every ${formatDuration(MIN_EVERY)}.`;
  if (spec.match) {
    try { new RegExp(spec.match, 'i'); } catch (error) { return `"${spec.match}" is not a valid pattern: ${error instanceof Error ? error.message : String(error)}.`; }
  }
  return undefined;
}

const NO_HITS = { hits: [], hitCount: 0, hitsOmitted: 0, firstHitAt: undefined } as const satisfies Partial<Job>;

/** The job with a line added to its history, newest first. */
const noted = (job: Job, at: number, text: string): Job => ({ ...job, history: [{ at, text }, ...job.history] });

const captured = (job: Job, line: string): Job =>
  job.hits.length < WAKE_LINES ? { ...job, hits: [...job.hits, line] } : { ...job, hitsOmitted: job.hitsOmitted + 1 };

/**
 * The job after new output lines: the tail and line count grow, and lines that match the pattern
 * (with the CONTEXT lines after each) are captured. `left` is how many context lines are still owed.
 */
export function takeLines(job: Job, lines: readonly string[], pattern: RegExp | undefined, left: number, now: number): Readonly<{ job: Job; left: number }> {
  const counted: Job = { ...job, tail: [...job.tail, ...lines].slice(-TAIL), lines: job.lines + lines.length };
  if (!pattern || !isActive(job) || job.paused || exhausted(job)) return { job: counted, left };
  return lines.reduce<Readonly<{ job: Job; left: number }>>((acc, line) => {
    if (pattern.test(line)) return { job: captured({ ...acc.job, hitCount: acc.job.hitCount + 1, firstHitAt: acc.job.firstHitAt ?? now }, line), left: CONTEXT };
    if (acc.left > 0) return { job: captured(acc.job, line), left: acc.left - 1 };
    return acc;
  }, { job: counted, left });
}

const setIn = <K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> => new Map([...map, [key, value]]);
const without = <K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> => new Map([...map].filter(([each]) => each !== key));
const plus = <T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => new Set([...set, value]);
const minus = <T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => new Set([...set].filter(each => each !== value));

/** Everything the manager knows, as one immutable value. Processes and log streams are handles it points to. */
type Book = Readonly<{
  jobs: ReadonlyMap<string, Job>;
  children: ReadonlyMap<string, ChildProcess>;
  logs: ReadonlyMap<string, WriteStream>;
  /** An output line not finished yet, per job. */
  partial: ReadonlyMap<string, string>;
  patterns: ReadonlyMap<string, RegExp>;
  /** Lines still to capture after the last matching line, per job. */
  context: ReadonlyMap<string, number>;
  listeners: ReadonlySet<() => void>;
  forced: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  restarting: ReadonlySet<string>;
  counter: number;
  disposed: boolean;
}>;

const EMPTY_BOOK: Book = {
  jobs: new Map(), children: new Map(), logs: new Map(), partial: new Map(), patterns: new Map(), context: new Map(),
  listeners: new Set(), forced: new Set(), removed: new Set(), restarting: new Set(), counter: 0, disposed: false,
};

/**
 * The jobs of one session. Owns their processes and logs; knows nothing about
 * Pi. The extension asks `due()` what to tell the agent when it is idle.
 * Jobs are immutable values: every change replaces the job, so a job handed out never changes later.
 */
export class Jobs {
  // The one field that changes: it holds the current book, which is always replaced, never edited.
  private book: Book = EMPTY_BOOK;

  constructor(private readonly logDir: string, private readonly now: () => number = Date.now) {}

  private with(change: Partial<Book>): void { this.book = { ...this.book, ...change }; }
  private put(job: Job): void { this.with({ jobs: setIn(this.book.jobs, job.id, job) }); }
  /** A job known to exist. */
  private current(id: string): Job { return this.book.jobs.get(id)!; }

  list(): Job[] { return [...this.book.jobs.values()]; }
  get(id: string): Job | undefined { return this.book.jobs.get(id); }
  active(): Job[] { return this.list().filter(isActive); }
  /** Active jobs that read this job's output. */
  followers(id: string): Job[] { return this.active().filter(job => job.follow === id); }
  /** Finished jobs a purge would delete: reported to the agent, and followed by nothing still active. */
  purgeable(): Job[] {
    return this.list().filter(job => !isActive(job) && !job.exitPending && !this.followers(job.id).length);
  }

  onChange(listener: () => void): () => void {
    this.with({ listeners: plus(this.book.listeners, listener) });
    return () => this.with({ listeners: minus(this.book.listeners, listener) });
  }

  /** The job, or an error that says whether it ever existed. */
  find(id: string): Job {
    const job = this.book.jobs.get(id);
    if (job) return job;
    if (this.book.removed.has(id)) throw new Error(`${id} was deleted from /jobs.`);
    throw new Error(`No job ${id}. Jobs: ${this.list().map(each => each.id).join(', ') || 'none'}.`);
  }

  start(spec: JobSpec): Job {
    this.admit(spec);
    const counter = this.book.counter + 1;
    const id = `j${counter}`;
    this.with({ counter });
    this.put({
      ...spec,
      id,
      state: 'waiting',
      startedAt: 0,
      checks: 0,
      paused: false,
      runs: 0,
      tail: [],
      lines: 0,
      reported: 0,
      exitPending: false,
      ...NO_HITS,
      history: [],
    });
    this.launch(id, spec.origin === 'person' ? 'started by you' : 'started');
    this.changed();
    return this.current(id);
  }

  /** Why the spec cannot run now, for a new job or for job `selfId` running again; undefined when it can. */
  whyNot(spec: JobSpec, selfId?: string): string | undefined {
    try { this.admit(spec, selfId ? this.book.jobs.get(selfId) : undefined); return undefined; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  /** Throws when the spec cannot run now, for a new job or for `self` restarting. */
  private admit(spec: JobSpec, self?: Job): void {
    if (this.book.disposed) throw new Error('This session has ended.');
    const invalid = specError(spec);
    if (invalid) throw new Error(invalid);
    if (spec.follow) {
      const source = this.book.jobs.get(spec.follow);
      if (!source) throw new Error(`No job ${spec.follow} to follow.`);
      if (source.id === self?.id) throw new Error('A job cannot follow itself.');
      if (!source.command) throw new Error(`${source.id} runs no command, so it has no output to follow.`);
    }
    if (spec.command) {
      const same = this.active().find(job => job.id !== self?.id && job.command === spec.command && job.cwd === spec.cwd);
      if (same) throw new Error(`${same.id} "${same.name}" already runs this command. Restart it instead of starting another.`);
    }
    if ((!self || !isActive(self)) && this.active().length >= MAX_ACTIVE) throw new Error(`${MAX_ACTIVE} jobs are already active. Stop one first.`);
  }

  /** Begin a run: fresh counters and output, then the process when there is a command. */
  private launch(id: string, why: string): void {
    const at = this.now();
    const job = this.current(id);
    const fresh = noted({
      ...job,
      state: job.command ? 'running' : 'waiting',
      startedAt: at,
      endedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      pid: undefined,
      checks: 0,
      paused: false,
      runs: job.runs + 1,
      nextCheckAt: job.every ? at + job.every : undefined,
      tail: [],
      lines: 0,
      reported: 0,
      exitPending: false,
      ...NO_HITS,
    }, at, why);
    this.put(fresh);
    this.with({ context: without(this.book.context, id), forced: minus(this.book.forced, id), partial: without(this.book.partial, id) });
    this.setPattern(fresh);
    if (fresh.command) this.spawn(id, fresh.command);
    else if (fresh.logFile) { rmSync(fresh.logFile, { force: true }); this.put({ ...fresh, logFile: undefined }); }
  }

  private setPattern(job: Job): void {
    this.with({ patterns: job.match ? setIn(this.book.patterns, job.id, new RegExp(job.match, 'i')) : without(this.book.patterns, job.id) });
  }

  private clearHits(id: string): void {
    this.put({ ...this.current(id), ...NO_HITS });
    this.with({ context: without(this.book.context, id) });
  }

  private spawn(id: string, command: string): void {
    mkdirSync(this.logDir, { recursive: true });
    const logFile = join(this.logDir, `${id}.log`);
    // Opened now, so a session that ends at once cannot race the lazy open.
    const log = createWriteStream(logFile, { fd: openSync(logFile, 'w') });
    log.on('error', () => { /* the log is a convenience; output also stays in memory */ });
    // Its own process group, so stopping it also stops what it started.
    const child = spawn('bash', ['-c', command], { cwd: this.current(id).cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    this.put({ ...this.current(id), logFile, pid: child.pid });
    this.with({ logs: setIn(this.book.logs, id, log), children: setIn(this.book.children, id, child) });
    const take = (chunk: Buffer) => { log.write(chunk); this.append(id, chunk.toString('utf8')); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', error => { this.append(id, `${error.message}\n`); this.finish(id, child, 127, null); });
    child.on('close', (code, signal) => this.finish(id, child, code, signal));
  }

  private append(id: string, text: string): void {
    // Output that arrives after the job was deleted has nowhere to go.
    if (!this.book.jobs.has(id)) return;
    const pieces = ((this.book.partial.get(id) ?? '') + text).split(/\r?\n/);
    this.with({ partial: setIn(this.book.partial, id, pieces.at(-1) ?? '') });
    const complete = pieces.slice(0, -1);
    if (!complete.length) return;
    const lines = complete.map(line => line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line);
    this.take(id, lines);
    for (const watcher of this.followers(id)) this.take(watcher.id, lines);
    this.changed();
  }

  /** Record output lines, and the ones that match the job's pattern. */
  private take(id: string, lines: readonly string[]): void {
    const left = this.book.context.get(id) ?? 0;
    const result = takeLines(this.current(id), lines, this.book.patterns.get(id), left, this.now());
    this.put(result.job);
    if (result.left !== left) this.with({ context: setIn(this.book.context, id, result.left) });
  }

  private finish(id: string, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.book.children.get(id) !== child) return;
    this.with({ children: without(this.book.children, id) });
    if (this.book.partial.get(id)) this.append(id, '\n');
    this.book.logs.get(id)?.end();
    this.with({ logs: without(this.book.logs, id) });
    const job = this.book.jobs.get(id);
    if (job) {
      const ended: Job = { ...job, pid: undefined, exitCode: code, signal };
      const at = this.now();
      this.put(ended.state === 'running'
        ? noted({ ...ended, state: code === 0 ? 'done' : 'failed', endedAt: at, nextCheckAt: undefined, exitPending: true }, at, signal ? `killed by ${signal}` : `exited ${code}`)
        : ended);
    }
    this.changed();
  }

  /** End a run without a word to history: SIGTERM to its process group, then SIGKILL. */
  private halt(id: string): void {
    this.put({ ...this.current(id), state: 'stopped', endedAt: this.now(), nextCheckAt: undefined, exitPending: false });
    this.clearHits(id);
    this.with({ forced: minus(this.book.forced, id) });
    const child = this.book.children.get(id);
    if (child?.pid) {
      kill(child.pid, 'SIGTERM');
      const pid = child.pid;
      setTimeout(() => { if (this.book.children.get(id) === child) kill(pid, 'SIGKILL'); }, KILL_GRACE).unref();
    }
  }

  /**
   * Stop a job: its process group gets SIGTERM, then SIGKILL, and its checks
   * end. It stays in the list. The jobs that follow it stop too.
   */
  stop(id: string, why = 'stopped'): Job {
    const job = this.find(id);
    if (!isActive(job)) return job;
    this.halt(id);
    const stopped = this.current(id);
    this.put(noted(stopped, stopped.endedAt!, why));
    for (const watcher of this.followers(id)) this.stop(watcher.id, `${id} stopped`);
    this.changed();
    return this.current(id);
  }

  /** Stop every active job. Returns them as they are once stopped. */
  stopAll(why = 'stopped'): Job[] {
    const going = this.active();
    for (const job of going) if (isActive(this.current(job.id))) this.stop(job.id, why);
    return going.map(job => this.current(job.id));
  }

  /**
   * Run a job again under the same id, so its watchers keep following it. The
   * old process group is gone before the new one starts, so a port is free.
   * `changes` edits the spec first.
   */
  async restart(id: string, why = 'restarted', changes: Partial<JobSpec> = {}): Promise<Job> {
    const job = this.find(id);
    if (this.book.restarting.has(id)) throw new Error(`${id} is already restarting.`);
    const next: JobSpec = { ...job, ...changes };
    this.admit(next, job);
    this.with({ restarting: plus(this.book.restarting, id) });
    try {
      const child = this.book.children.get(id);
      if (child) {
        if (isActive(this.current(id))) { this.halt(id); this.changed(); }
        await this.exited(child);
        if (this.book.children.get(id) === child) throw new Error(`${id} did not exit; try again.`);
      }
      const still = this.book.jobs.get(id);
      if (!still) throw new Error(`${id} was deleted while restarting.`);
      this.admit(next, still);
      this.put({ ...still, ...changes });
      this.launch(id, why);
      this.changed();
      return this.current(id);
    } finally {
      this.with({ restarting: minus(this.book.restarting, id) });
    }
  }

  /** Resolves when the process has closed, or after EXIT_WAIT. */
  private exited(child: ChildProcess): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, EXIT_WAIT);
      timer.unref();
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  /** Change how an active job is watched, without touching its process. */
  edit(id: string, changes: Partial<Pick<JobSpec, 'name' | 'every' | 'match' | 'check' | 'maxChecks'>>, why = 'edited'): Job {
    const job = this.find(id);
    if (!isActive(job)) throw new Error(`${id} is not active; restart it to run it again.`);
    const invalid = specError({ ...job, ...changes });
    if (invalid) throw new Error(invalid);
    const at = this.now();
    const edited: Job = { ...job, ...changes };
    this.put(edited);
    if ('match' in changes) { this.setPattern(edited); this.clearHits(id); }
    if ('every' in changes || 'maxChecks' in changes) {
      const current = this.current(id);
      this.put({ ...current, nextCheckAt: current.every && !current.paused && !exhausted(current) ? at + current.every : undefined });
    }
    this.put(noted(this.current(id), at, why));
    this.retire(id, at);
    this.changed();
    return this.current(id);
  }

  /** Hold checks and matches; the process keeps running and an exit is still reported. */
  pause(id: string): Job {
    const job = this.find(id);
    if (!isActive(job) || job.paused) return job;
    this.put({ ...job, paused: true, nextCheckAt: undefined });
    this.clearHits(id);
    this.put(noted(this.current(id), this.now(), 'checks paused'));
    this.changed();
    return this.current(id);
  }

  resume(id: string): Job {
    const job = this.find(id);
    if (!isActive(job) || !job.paused) return job;
    const at = this.now();
    this.put(noted({ ...job, paused: false, nextCheckAt: job.every && !exhausted(job) ? at + job.every : undefined }, at, 'checks resumed'));
    this.changed();
    return this.current(id);
  }

  /** Delete a job from the list, stopping it first, with its log. Watchers that follow it stop. */
  remove(id: string, why = 'deleted'): Job {
    this.find(id);
    for (const watcher of this.followers(id)) this.stop(watcher.id, `${id} was deleted`);
    if (isActive(this.current(id))) this.stop(id, why);
    const job = this.current(id);
    this.with({
      jobs: without(this.book.jobs, id),
      removed: plus(this.book.removed, id),
      forced: minus(this.book.forced, id),
      patterns: without(this.book.patterns, id),
      context: without(this.book.context, id),
    });
    if (job.logFile) rmSync(job.logFile, { force: true });
    this.changed();
    return job;
  }

  /** Delete every finished job whose end the agent has heard about. Returns the ones it deleted. */
  purge(): Job[] {
    return this.purgeable().map(job => this.remove(job.id));
  }

  /** Make an active job due now. */
  checkNow(id: string): void {
    const job = this.find(id);
    if (!isActive(job)) return;
    this.with({ forced: plus(this.book.forced, id) });
    this.changed();
  }

  /** Why `due()` would act on this job now; 'silent' is a check with no new output to report. */
  private reason(job: Job, at: number): Wake['reason'] | 'silent' | undefined {
    if (job.exitPending) return 'exit';
    if (!isActive(job)) return undefined;
    if (this.book.forced.has(job.id)) return 'check';
    if (job.paused || exhausted(job)) return undefined;
    if (job.hits.length && at - job.firstHitAt! >= SETTLE && at - (job.lastMatchAt ?? -Infinity) >= MATCH_GAP) return 'match';
    if (job.nextCheckAt !== undefined && job.nextCheckAt <= at) return readsOutput(job) && job.lines === job.reported ? 'silent' : 'check';
    return undefined;
  }

  /** True when `due()` has something to do. */
  hasDue(): boolean {
    const at = this.now();
    return this.list().some(job => this.reason(job, at) !== undefined);
  }

  /** Take everything the agent should hear about now, and schedule the next checks. */
  due(): Wake[] {
    const at = this.now();
    const due = this.list().filter(job => this.reason(job, at) !== undefined);
    const wakes = due.flatMap(job => this.wake(job.id, at));
    if (due.length) this.changed();
    return wakes;
  }

  /** Report one due job: what the agent hears, and the job marked as reported. */
  private wake(id: string, at: number): Wake[] {
    const job = this.current(id);
    const reason = this.reason(job, at);
    if (!reason) return [];
    // A job that prints nothing new has nothing to check; wait for the next interval.
    if (reason === 'silent') { this.put({ ...job, nextCheckAt: at + job.every! }); return []; }
    this.with({ forced: minus(this.book.forced, id) });
    const hits = reason !== 'exit' && job.hits.length > 0;
    const matched = hits ? job.hitCount : 0;
    const fresh = job.lines - job.reported;
    const output = hits ? job.hits : fresh > 0 ? job.tail.slice(-Math.min(fresh, WAKE_LINES)) : [];
    const omitted = hits ? job.hitsOmitted : Math.max(0, fresh - output.length);
    const source = job.follow ? this.book.jobs.get(job.follow) : undefined;
    const reported: Job = { ...job, lastMatchAt: hits ? at : job.lastMatchAt, reported: job.lines, exitPending: false };
    this.put(reported);
    this.clearHits(id);
    if (reason !== 'exit') {
      const current = this.current(id);
      const checks = current.checks + 1;
      const nextCheckAt = reason === 'check' ? (current.every && !current.paused ? at + current.every : undefined) : current.nextCheckAt;
      this.put(noted({ ...current, checks, nextCheckAt }, at, matched ? `woke on ${plural(matched, 'matching line')}` : `check ${checks}`));
      this.retire(id, at);
    }
    return [{ job: this.current(id), reason, output, omitted, matched, source: source && { id: source.id, name: source.name, logFile: source.logFile } }];
  }

  /** A job with nothing left to wake the agent about ends; a command keeps running. */
  private retire(id: string, at: number): void {
    if (!exhausted(this.current(id))) return;
    this.put({ ...this.current(id), nextCheckAt: undefined });
    this.clearHits(id);
    const job = this.current(id);
    if (!job.command && isActive(job)) this.put(noted({ ...job, state: 'done', endedAt: at }, at, 'last check done'));
  }

  /** Kill every process and delete the logs. Idempotent. */
  dispose(): void {
    if (this.book.disposed) return;
    const { children, logs } = this.book;
    this.with({ disposed: true, children: new Map(), logs: new Map(), listeners: new Set() });
    for (const child of children.values()) if (child.pid) kill(child.pid, 'SIGKILL');
    for (const log of logs.values()) log.end();
    rmSync(this.logDir, { recursive: true, force: true });
  }

  private changed(): void {
    for (const listener of this.book.listeners) listener();
  }
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the agent reads when it wakes for one or more jobs. */
export function wakeText(wakes: readonly Wake[], now = Date.now()): string {
  return wakes.map(({ job, reason, output, omitted, matched, source }) => {
    const label = `Background job ${job.id} "${job.name}"`;
    const head = reason === 'exit'
      ? `${label} ${job.signal ? `was killed by ${job.signal}` : `exited with code ${job.exitCode}`} after ${formatDuration((job.endedAt ?? now) - job.startedAt)}.`
      : matched
        ? `${label}: ${plural(matched, 'new line')} matched /${job.match}/.`
        : `${label}, check ${job.checks}${job.maxChecks ? ` of ${job.maxChecks}` : ''}${job.every ? ` (every ${formatDuration(job.every)})` : ''}.`;
    const lines = [job.origin === 'person' ? `${head} The person started this job from /jobs.` : head];
    if (job.command) lines.push(`Command: ${job.command} (cwd ${job.cwd})${job.state === 'running' ? `, running for ${formatDuration(now - job.startedAt)}` : ''}.`);
    if (job.follow) lines.push(`It follows the output of ${source ? `${source.id} "${source.name}"` : job.follow}.`);
    if (readsOutput(job)) {
      const log = source?.logFile ?? job.logFile;
      if (!output.length) lines.push('No new output since the last report.');
      else if (matched) lines.push(`Matching lines with the lines after them${omitted ? ` (first ${output.length}; ${omitted} more in ${log})` : ''}:`, ...output.map(line => `  ${line}`));
      else lines.push(`New output${omitted ? ` (last ${output.length} lines; ${omitted} earlier in ${log})` : ''}:`, ...output.map(line => `  ${line}`));
    }
    if (job.check && reason !== 'exit') lines.push(`Check: ${job.check}`);
    if (reason !== 'exit') {
      if (exhausted(job)) lines.push('That was the last check.');
      else {
        if (job.nextCheckAt) lines.push(`Next check in ${formatDuration(job.nextCheckAt - now)}.`);
        if (job.match) lines.push(`A new matching line wakes you again, at most every ${formatDuration(MATCH_GAP)}.`);
        lines.push(`Call job_stop with id "${job.id}" when it no longer needs watching.`);
      }
    }
    return lines.join('\n');
  }).join('\n\n');
}
