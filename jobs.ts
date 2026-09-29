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

export type Job = JobSpec & {
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
  tail: string[];
  /** Every line the job has written, including those no longer in `tail`. */
  lines: number;
  /** `lines` at the last report to the agent. */
  reported: number;
  /** An exit the agent has not been told about. */
  exitPending: boolean;
  /** Lines that matched, each with the lines after it, not yet reported. At most WAKE_LINES. */
  hits: string[];
  /** Matching lines not yet reported, including those past the `hits` cap. */
  hitCount: number;
  /** Captured lines that did not fit in `hits`. */
  hitsOmitted: number;
  firstHitAt?: number;
  lastMatchAt?: number;
  history: { at: number; text: string }[];
};

/** One reason to wake the agent about one job. */
export type Wake = {
  job: Job;
  reason: 'check' | 'match' | 'exit';
  /** Matching lines when there are any, otherwise the new lines since the last report. At most WAKE_LINES. */
  output: string[];
  /** Lines not included in `output`. */
  omitted: number;
  /** Matching lines behind this wake; 0 when `output` is plain new output. */
  matched: number;
  /** The job a watcher follows. */
  source?: Pick<Job, 'id' | 'name' | 'logFile'>;
};

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

export const isActive = (job: Job): boolean => job.state === 'running' || job.state === 'waiting';

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

/**
 * The jobs of one session. Owns their processes and logs; knows nothing about
 * Pi. The extension asks `due()` what to tell the agent when it is idle.
 */
export class Jobs {
  private readonly jobs = new Map<string, Job>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly logs = new Map<string, WriteStream>();
  private readonly partial = new Map<string, string>();
  private readonly patterns = new Map<string, RegExp>();
  /** Lines still to capture after the last matching line, per job. */
  private readonly context = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly forced = new Set<string>();
  private readonly removed = new Set<string>();
  private readonly restarting = new Set<string>();
  private counter = 0;
  private disposed = false;

  constructor(private readonly logDir: string, private readonly now: () => number = Date.now) {}

  list(): Job[] { return [...this.jobs.values()]; }
  get(id: string): Job | undefined { return this.jobs.get(id); }
  active(): Job[] { return this.list().filter(isActive); }
  /** Active jobs that read this job's output. */
  followers(id: string): Job[] { return this.active().filter(job => job.follow === id); }
  /** Finished jobs a purge would delete: reported to the agent, and followed by nothing still active. */
  purgeable(): Job[] {
    return this.list().filter(job => !isActive(job) && !job.exitPending && !this.followers(job.id).length);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The job, or an error that says whether it ever existed. */
  find(id: string): Job {
    const job = this.jobs.get(id);
    if (job) return job;
    if (this.removed.has(id)) throw new Error(`${id} was deleted from /jobs.`);
    throw new Error(`No job ${id}. Jobs: ${this.list().map(each => each.id).join(', ') || 'none'}.`);
  }

  start(spec: JobSpec): Job {
    this.admit(spec);
    const job: Job = {
      ...spec,
      id: `j${++this.counter}`,
      state: 'waiting',
      startedAt: 0,
      checks: 0,
      paused: false,
      runs: 0,
      tail: [],
      lines: 0,
      reported: 0,
      exitPending: false,
      hits: [],
      hitCount: 0,
      hitsOmitted: 0,
      history: [],
    };
    this.jobs.set(job.id, job);
    this.launch(job, spec.origin === 'person' ? 'started by you' : 'started');
    this.changed();
    return job;
  }

  /** Why the spec cannot run now, for a new job or for job `selfId` running again; undefined when it can. */
  whyNot(spec: JobSpec, selfId?: string): string | undefined {
    try { this.admit(spec, selfId ? this.jobs.get(selfId) : undefined); return undefined; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  /** Throws when the spec cannot run now, for a new job or for `self` restarting. */
  private admit(spec: JobSpec, self?: Job): void {
    if (this.disposed) throw new Error('This session has ended.');
    const invalid = specError(spec);
    if (invalid) throw new Error(invalid);
    if (spec.follow) {
      const source = this.jobs.get(spec.follow);
      if (!source) throw new Error(`No job ${spec.follow} to follow.`);
      if (source === self) throw new Error('A job cannot follow itself.');
      if (!source.command) throw new Error(`${source.id} runs no command, so it has no output to follow.`);
    }
    if (spec.command) {
      const same = this.active().find(job => job !== self && job.command === spec.command && job.cwd === spec.cwd);
      if (same) throw new Error(`${same.id} "${same.name}" already runs this command. Restart it instead of starting another.`);
    }
    if ((!self || !isActive(self)) && this.active().length >= MAX_ACTIVE) throw new Error(`${MAX_ACTIVE} jobs are already active. Stop one first.`);
  }

  /** Begin a run: fresh counters and output, then the process when there is a command. */
  private launch(job: Job, why: string): void {
    const at = this.now();
    Object.assign(job, {
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
    } satisfies Partial<Job>);
    this.clearHits(job);
    this.forced.delete(job.id);
    this.partial.delete(job.id);
    this.setPattern(job);
    job.history.unshift({ at, text: why });
    if (job.command) this.spawn(job, job.command);
    else if (job.logFile) { rmSync(job.logFile, { force: true }); job.logFile = undefined; }
  }

  private setPattern(job: Job): void {
    if (job.match) this.patterns.set(job.id, new RegExp(job.match, 'i'));
    else this.patterns.delete(job.id);
  }

  private clearHits(job: Job): void {
    job.hits = [];
    job.hitCount = 0;
    job.hitsOmitted = 0;
    job.firstHitAt = undefined;
    this.context.delete(job.id);
  }

  private spawn(job: Job, command: string): void {
    mkdirSync(this.logDir, { recursive: true });
    job.logFile = join(this.logDir, `${job.id}.log`);
    // Opened now, so a session that ends at once cannot race the lazy open.
    const log = createWriteStream(job.logFile, { fd: openSync(job.logFile, 'w') });
    log.on('error', () => { /* the log is a convenience; output also stays in memory */ });
    this.logs.set(job.id, log);
    // Its own process group, so stopping it also stops what it started.
    const child = spawn('bash', ['-c', command], { cwd: job.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    job.pid = child.pid;
    this.children.set(job.id, child);
    const take = (chunk: Buffer) => { log.write(chunk); this.append(job, chunk.toString('utf8')); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', error => { this.append(job, `${error.message}\n`); this.finish(job, child, 127, null); });
    child.on('close', (code, signal) => this.finish(job, child, code, signal));
  }

  private append(job: Job, text: string): void {
    const pieces = ((this.partial.get(job.id) ?? '') + text).split(/\r?\n/);
    this.partial.set(job.id, pieces.pop() ?? '');
    if (!pieces.length) return;
    const lines = pieces.map(line => line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line);
    this.take(job, lines);
    for (const watcher of this.followers(job.id)) this.take(watcher, lines);
    this.changed();
  }

  /** Record output lines, and the ones that match the job's pattern. */
  private take(job: Job, lines: string[]): void {
    job.tail.push(...lines);
    if (job.tail.length > TAIL) job.tail.splice(0, job.tail.length - TAIL);
    job.lines += lines.length;
    const pattern = this.patterns.get(job.id);
    if (!pattern || !isActive(job) || job.paused || exhausted(job)) return;
    let left = this.context.get(job.id) ?? 0;
    for (const line of lines) {
      if (pattern.test(line)) { job.hitCount += 1; job.firstHitAt ??= this.now(); left = CONTEXT; }
      else if (left > 0) left -= 1;
      else continue;
      if (job.hits.length < WAKE_LINES) job.hits.push(line); else job.hitsOmitted += 1;
    }
    this.context.set(job.id, left);
  }

  private finish(job: Job, child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.children.get(job.id) !== child) return;
    this.children.delete(job.id);
    if (this.partial.get(job.id)) this.append(job, '\n');
    this.logs.get(job.id)?.end();
    this.logs.delete(job.id);
    job.pid = undefined;
    job.exitCode = code;
    job.signal = signal;
    if (job.state === 'running') {
      job.state = code === 0 ? 'done' : 'failed';
      job.endedAt = this.now();
      job.nextCheckAt = undefined;
      job.exitPending = true;
      job.history.unshift({ at: job.endedAt, text: signal ? `killed by ${signal}` : `exited ${code}` });
    }
    this.changed();
  }

  /** End a run without a word to history: SIGTERM to its process group, then SIGKILL. */
  private halt(job: Job): void {
    job.state = 'stopped';
    job.endedAt = this.now();
    job.nextCheckAt = undefined;
    job.exitPending = false;
    this.clearHits(job);
    this.forced.delete(job.id);
    const child = this.children.get(job.id);
    if (child?.pid) {
      kill(child.pid, 'SIGTERM');
      const pid = child.pid;
      setTimeout(() => { if (this.children.get(job.id) === child) kill(pid, 'SIGKILL'); }, KILL_GRACE).unref();
    }
  }

  /**
   * Stop a job: its process group gets SIGTERM, then SIGKILL, and its checks
   * end. It stays in the list. The jobs that follow it stop too.
   */
  stop(id: string, why = 'stopped'): Job {
    const job = this.find(id);
    if (!isActive(job)) return job;
    this.halt(job);
    job.history.unshift({ at: job.endedAt!, text: why });
    for (const watcher of this.followers(id)) this.stop(watcher.id, `${id} stopped`);
    this.changed();
    return job;
  }

  /** Stop every active job. Returns the ones it stopped. */
  stopAll(why = 'stopped'): Job[] {
    const going = this.active();
    for (const job of going) if (isActive(job)) this.stop(job.id, why);
    return going;
  }

  /**
   * Run a job again under the same id, so its watchers keep following it. The
   * old process group is gone before the new one starts, so a port is free.
   * `changes` edits the spec first.
   */
  async restart(id: string, why = 'restarted', changes: Partial<JobSpec> = {}): Promise<Job> {
    const job = this.find(id);
    if (this.restarting.has(id)) throw new Error(`${id} is already restarting.`);
    const next: JobSpec = { ...job, ...changes };
    this.admit(next, job);
    this.restarting.add(id);
    try {
      const child = this.children.get(id);
      if (child) {
        if (isActive(job)) { this.halt(job); this.changed(); }
        await this.exited(child);
        if (this.children.get(id) === child) throw new Error(`${id} did not exit; try again.`);
      }
      if (this.jobs.get(id) !== job) throw new Error(`${id} was deleted while restarting.`);
      this.admit(next, job);
      Object.assign(job, changes);
      this.launch(job, why);
      this.changed();
      return job;
    } finally {
      this.restarting.delete(id);
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
    Object.assign(job, changes);
    if ('match' in changes) { this.setPattern(job); this.clearHits(job); }
    if ('every' in changes || 'maxChecks' in changes) job.nextCheckAt = job.every && !job.paused && !exhausted(job) ? at + job.every : undefined;
    job.history.unshift({ at, text: why });
    this.retire(job, at);
    this.changed();
    return job;
  }

  /** Hold checks and matches; the process keeps running and an exit is still reported. */
  pause(id: string): Job {
    const job = this.find(id);
    if (!isActive(job) || job.paused) return job;
    job.paused = true;
    job.nextCheckAt = undefined;
    this.clearHits(job);
    job.history.unshift({ at: this.now(), text: 'checks paused' });
    this.changed();
    return job;
  }

  resume(id: string): Job {
    const job = this.find(id);
    if (!isActive(job) || !job.paused) return job;
    const at = this.now();
    job.paused = false;
    job.nextCheckAt = job.every && !exhausted(job) ? at + job.every : undefined;
    job.history.unshift({ at, text: 'checks resumed' });
    this.changed();
    return job;
  }

  /** Delete a job from the list, stopping it first, with its log. Watchers that follow it stop. */
  remove(id: string, why = 'deleted'): Job {
    const job = this.find(id);
    for (const watcher of this.followers(id)) this.stop(watcher.id, `${id} was deleted`);
    if (isActive(job)) this.stop(id, why);
    this.jobs.delete(id);
    this.removed.add(id);
    this.forced.delete(id);
    this.patterns.delete(id);
    this.context.delete(id);
    if (job.logFile) rmSync(job.logFile, { force: true });
    this.changed();
    return job;
  }

  /** Delete every finished job whose end the agent has heard about. Returns the ones it deleted. */
  purge(): Job[] {
    const going = this.purgeable();
    for (const job of going) this.remove(job.id);
    return going;
  }

  /** Make an active job due now. */
  checkNow(id: string): void {
    const job = this.find(id);
    if (!isActive(job)) return;
    this.forced.add(id);
    this.changed();
  }

  /** Why `due()` would act on this job now; 'silent' is a check with no new output to report. */
  private reason(job: Job, at: number): Wake['reason'] | 'silent' | undefined {
    if (job.exitPending) return 'exit';
    if (!isActive(job)) return undefined;
    if (this.forced.has(job.id)) return 'check';
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
    const wakes: Wake[] = [];
    let touched = false;
    for (const job of this.list()) {
      const reason = this.reason(job, at);
      if (!reason) continue;
      touched = true;
      // A job that prints nothing new has nothing to check; wait for the next interval.
      if (reason === 'silent') { job.nextCheckAt = at + job.every!; continue; }
      this.forced.delete(job.id);
      const hits = reason !== 'exit' && job.hits.length > 0;
      const matched = hits ? job.hitCount : 0;
      const fresh = job.lines - job.reported;
      const output = hits ? job.hits : fresh > 0 ? job.tail.slice(-Math.min(fresh, WAKE_LINES)) : [];
      const source = job.follow ? this.jobs.get(job.follow) : undefined;
      wakes.push({
        job,
        reason,
        output,
        omitted: hits ? job.hitsOmitted : Math.max(0, fresh - output.length),
        matched,
        source: source && { id: source.id, name: source.name, logFile: source.logFile },
      });
      if (hits) job.lastMatchAt = at;
      job.reported = job.lines;
      job.exitPending = false;
      this.clearHits(job);
      if (reason === 'exit') continue;
      job.checks += 1;
      job.history.unshift({ at, text: matched ? `woke on ${plural(matched, 'matching line')}` : `check ${job.checks}` });
      if (reason === 'check') job.nextCheckAt = job.every && !job.paused ? at + job.every : undefined;
      this.retire(job, at);
    }
    if (touched) this.changed();
    return wakes;
  }

  /** A job with nothing left to wake the agent about ends; a command keeps running. */
  private retire(job: Job, at: number): void {
    if (!exhausted(job)) return;
    job.nextCheckAt = undefined;
    this.clearHits(job);
    if (!job.command && isActive(job)) { job.state = 'done'; job.endedAt = at; job.history.unshift({ at, text: 'last check done' }); }
  }

  /** Kill every process and delete the logs. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, child] of this.children) {
      if (child.pid) kill(child.pid, 'SIGKILL');
      this.children.delete(id);
    }
    for (const log of this.logs.values()) log.end();
    this.logs.clear();
    this.listeners.clear();
    rmSync(this.logDir, { recursive: true, force: true });
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
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
