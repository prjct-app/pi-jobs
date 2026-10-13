import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Jobs, MATCH_GAP, formatDuration, parseDuration, specError, wakeText, type Job } from '../jobs.ts';

const dir = () => join(tmpdir(), `pi-jobs-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
const until = async (ok: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 20));
  }
};
/** Jobs are immutable values: read the newest one by id. */
const latest = (jobs: Jobs, job: Job): Job => jobs.get(job.id)!;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A fake clock: the only mutable state in these tests, behind two named operations. */
const createClock = (start: number) => {
  const state = { at: start };
  return { now: () => state.at, advance: (ms: number) => { state.at += ms; } };
};

test('durations parse and format', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('5 minutes'), undefined);
  assert.equal(parseDuration('0s'), undefined);
  assert.equal(formatDuration(90_000), '1m30s');
  assert.equal(formatDuration(0), '0s');
});

test('a job needs something to do, and a sane interval', () => {
  const jobs = new Jobs(dir());
  assert.throws(() => jobs.start({ name: 'x', cwd: '/' }), /command to run/);
  assert.throws(() => jobs.start({ name: 'x', cwd: '/', every: 60_000 }), /check instruction/);
  assert.throws(() => jobs.start({ name: 'x', cwd: '/', command: 'true', every: 20_000 }), /at most every 1m/);
  assert.match(specError({ command: 'x', follow: 'j1', match: 'e' })!, /not both/);
  assert.match(specError({ follow: 'j1' })!, /needs match, every, or both/);
  assert.match(specError({ every: 60_000, check: 'look', match: 'error' })!, /match reads output/);
  assert.match(specError({ command: 'x', match: '(' })!, /not a valid pattern/);
  assert.equal(specError({ command: 'x', match: 'error|exception' }), undefined);
  jobs.dispose();
});

test('an exit is reported once, with its new output and a log file', async () => {
  const logs = dir();
  const jobs = new Jobs(logs);
  const job = jobs.start({ name: 'echo', cwd: '/', command: 'echo one; echo two >&2; exit 3' });
  await until(() => jobs.hasDue());
  assert.equal(latest(jobs, job).state, 'failed');
  const [wake] = jobs.due();
  assert.equal(wake.reason, 'exit');
  assert.deepEqual([...wake.output].sort(), ['one', 'two']);
  assert.match(wakeText([wake]), /exited with code 3/);
  assert.equal(jobs.hasDue(), false);
  assert.deepEqual(jobs.due(), []);
  assert.match(readFileSync(latest(jobs, job).logFile!, 'utf8'), /one/);
  jobs.dispose();
  assert.equal(existsSync(logs), false);
});

test('checks come due on the interval and report only new output', () => {
  const clock = createClock(1_000_000);
  const jobs = new Jobs(dir(), () => clock.now());
  const job = jobs.start({ name: 'deploy', cwd: '/', every: 60_000, check: 'Is it green?', maxChecks: 2 });
  assert.equal(latest(jobs, job).state, 'waiting');
  assert.equal(jobs.hasDue(), false);
  clock.advance(60_000);
  const [first] = jobs.due();
  assert.equal(first.reason, 'check');
  assert.equal(latest(jobs, job).checks, 1);
  assert.match(wakeText([first], clock.now()), /check 1 of 2[\s\S]*Check: Is it green\?[\s\S]*Next check in 1m/);
  assert.equal(jobs.hasDue(), false);
  clock.advance(60_000);
  assert.equal(jobs.due().length, 1);
  assert.equal(latest(jobs, job).state, 'done');
  clock.advance(600_000);
  assert.equal(jobs.hasDue(), false);
  jobs.dispose();
});

test('a command that prints nothing new does not wake the agent on its interval', async () => {
  const clock = createClock(0);
  const jobs = new Jobs(dir(), () => clock.now());
  const job = jobs.start({ name: 'server', cwd: '/', command: 'echo listening; sleep 30', every: 60_000, check: 'look' });
  await until(() => latest(jobs, job).lines === 1);
  clock.advance(60_000);
  const [first] = jobs.due();
  assert.deepEqual(first.output, ['listening']);
  clock.advance(60_000);
  assert.deepEqual(jobs.due(), [], 'silent: nothing to report');
  assert.equal(latest(jobs, job).checks, 1);
  assert.equal(latest(jobs, job).nextCheckAt, clock.now() + 60_000);
  // A check the person asks for still arrives, and it does not repeat old output.
  jobs.checkNow(job.id);
  const [forced] = jobs.due();
  assert.deepEqual(forced.output, []);
  assert.equal(forced.omitted, 0);
  assert.match(wakeText([forced], clock.now()), /No new output since the last report/);
  jobs.dispose();
});

test('check now makes an active job due immediately', () => {
  const jobs = new Jobs(dir(), () => 0);
  const job = jobs.start({ name: 'r', cwd: '/', every: 3_600_000, check: 'look' });
  jobs.checkNow(job.id);
  assert.equal(jobs.due().length, 1);
  jobs.dispose();
});

test('a matching line wakes the agent with the lines after it, at most once per gap', async () => {
  const clock = createClock(0);
  const jobs = new Jobs(dir(), () => clock.now());
  const job = jobs.start({ name: 'dev', cwd: '/', command: 'echo ready; echo "Error: boom"; echo "  at handler"; sleep 0.4; echo "error two"; sleep 30', match: 'error', check: 'Fix it.' });
  await until(() => latest(jobs, job).hitCount === 1 && latest(jobs, job).hits.length === 2);
  assert.equal(jobs.hasDue(), false, 'waits for the lines that follow');
  clock.advance(2_000);
  const [wake] = jobs.due();
  assert.equal(wake.reason, 'match');
  assert.equal(wake.matched, 1);
  assert.deepEqual(wake.output, ['Error: boom', '  at handler']);
  assert.match(wakeText([wake], clock.now()), /1 new line matched \/error\/[\s\S]*Error: boom[\s\S]*Check: Fix it\.[\s\S]*at most every 30s/);
  await until(() => latest(jobs, job).hitCount === 1);
  clock.advance(2_000);
  assert.equal(jobs.hasDue(), false, 'the gap holds the next match');
  clock.advance(MATCH_GAP);
  const [next] = jobs.due();
  assert.deepEqual(next.output, ['error two']);
  assert.equal(latest(jobs, job).checks, 2);
  jobs.dispose();
});

test('a watcher follows another job, and stops when that job is deleted', async () => {
  const clock = createClock(0);
  const jobs = new Jobs(dir(), () => clock.now());
  const server = jobs.start({ name: 'dev server', cwd: '/', command: 'sleep 0.3; echo "TypeError: x is undefined"; sleep 30' });
  const watcher = jobs.start({ name: 'dev errors', cwd: '/', follow: server.id, match: 'error|exception', check: 'Find the cause and fix it.' });
  assert.equal(latest(jobs, watcher).state, 'waiting');
  await until(() => latest(jobs, watcher).hitCount === 1);
  clock.advance(2_000);
  const wakes = jobs.due();
  assert.deepEqual(wakes.map(w => w.job.id), [watcher.id], 'only the watcher wakes; the server has no checks');
  assert.match(wakeText(wakes, clock.now()), /follows the output of j1 "dev server"[\s\S]*TypeError/);
  assert.throws(() => jobs.start({ name: 'x', cwd: '/', follow: watcher.id, match: 'e' }), /runs no command/);
  jobs.remove(server.id);
  assert.equal(latest(jobs, watcher).state, 'stopped');
  assert.equal(latest(jobs, watcher).history[0]!.text, 'j1 was deleted');
  assert.throws(() => jobs.find(server.id), /j1 was deleted from \/jobs/);
  jobs.dispose();
});

test('the same command cannot run twice; restart it instead', () => {
  const jobs = new Jobs(dir());
  jobs.start({ name: 'a', cwd: '/', command: 'sleep 30' });
  assert.throws(() => jobs.start({ name: 'b', cwd: '/', command: 'sleep 30' }), /j1 "a" already runs this command\. Restart it/);
  jobs.start({ name: 'c', cwd: '/tmp', command: 'sleep 30' });
  jobs.dispose();
});

test('restart keeps the id and its watchers, and the old process is gone first', async () => {
  const jobs = new Jobs(dir());
  const server = jobs.start({ name: 'server', cwd: '/', command: 'echo first; sleep 30' });
  const watcher = jobs.start({ name: 'errors', cwd: '/', follow: server.id, match: 'error' });
  await until(() => latest(jobs, server).lines === 1);
  const old = latest(jobs, server).pid!;
  const again = await jobs.restart(server.id, 'restarted by you', { command: 'echo second; sleep 30' });
  assert.equal(again.id, server.id);
  assert.equal(again, latest(jobs, server), 'restart returns the job as it is now');
  assert.equal(alive(old), false);
  assert.equal(latest(jobs, server).state, 'running');
  assert.equal(latest(jobs, server).runs, 2);
  assert.notEqual(latest(jobs, server).pid, old);
  await until(() => latest(jobs, server).lines === 1);
  assert.deepEqual(latest(jobs, server).tail, ['second']);
  assert.equal(latest(jobs, watcher).state, 'waiting', 'the watcher keeps following');
  assert.equal(latest(jobs, server).history[0]!.text, 'restarted by you');
  jobs.dispose();
});

test('a finished job restarts as a new run', async () => {
  const jobs = new Jobs(dir());
  const job = jobs.start({ name: 'build', cwd: '/', command: 'exit 1' });
  await until(() => latest(jobs, job).state === 'failed');
  jobs.due();
  await jobs.restart(job.id);
  assert.equal(latest(jobs, job).state, 'running');
  assert.equal(latest(jobs, job).exitCode, undefined);
  await until(() => latest(jobs, job).state === 'failed');
  jobs.dispose();
});

test('pause holds checks; resume starts the interval again', () => {
  const clock = createClock(0);
  const jobs = new Jobs(dir(), () => clock.now());
  const job = jobs.start({ name: 'r', cwd: '/', every: 60_000, check: 'look' });
  jobs.pause(job.id);
  clock.advance(600_000);
  assert.equal(jobs.hasDue(), false);
  jobs.resume(job.id);
  assert.equal(latest(jobs, job).nextCheckAt, clock.now() + 60_000);
  assert.deepEqual(latest(jobs, job).history.slice(0, 2).map(h => h.text), ['checks resumed', 'checks paused']);
  jobs.dispose();
});

test('edit changes how a running job is watched without touching it', () => {
  const clock = createClock(0);
  const jobs = new Jobs(dir(), () => clock.now());
  const job = jobs.start({ name: 'r', cwd: '/', every: 60_000, check: 'look' });
  jobs.edit(job.id, { every: 300_000, name: 'slower' });
  assert.equal(latest(jobs, job).nextCheckAt, 300_000);
  assert.equal(latest(jobs, job).name, 'slower');
  assert.throws(() => jobs.edit(job.id, { every: 10_000 }), /at most every/);
  clock.advance(300_000);
  jobs.due();
  jobs.edit(job.id, { maxChecks: 1 });
  assert.equal(latest(jobs, job).state, 'done', 'no checks left');
  jobs.dispose();
});

test('stop kills the whole process group and reports nothing', async () => {
  const jobs = new Jobs(dir());
  const job: Job = jobs.start({ name: 'sleep', cwd: '/', command: 'sleep 30 & sleep 30; wait', every: 60_000 });
  await until(() => latest(jobs, job).pid !== undefined);
  const pid = latest(jobs, job).pid!;
  jobs.stop(job.id);
  assert.equal(latest(jobs, job).state, 'stopped');
  await until(() => !alive(pid));
  assert.equal(jobs.hasDue(), false);
  assert.equal(jobs.active().length, 0);
  jobs.dispose();
});

test('stop all ends every active job; purge deletes the finished ones the agent has heard about', async () => {
  const jobs = new Jobs(dir());
  const quick = jobs.start({ name: 'quick', cwd: '/', command: 'echo done' });
  await until(() => latest(jobs, quick).state === 'done');
  assert.deepEqual(jobs.purgeable(), [], 'its exit has not reached the agent yet');
  jobs.due();
  const a = jobs.start({ name: 'a', cwd: '/', command: 'sleep 30' });
  const b = jobs.start({ name: 'b', cwd: '/', every: 60_000, check: 'look' });
  assert.deepEqual(jobs.stopAll('stopped by you').map(j => j.id), [a.id, b.id]);
  assert.equal(jobs.active().length, 0);
  const log = latest(jobs, quick).logFile!;
  assert.deepEqual(jobs.purge().map(j => j.id), [quick.id, a.id, b.id]);
  assert.equal(jobs.list().length, 0);
  assert.equal(existsSync(log), false);
  jobs.dispose();
});

test('purge keeps a finished job that an active watcher still follows', async () => {
  const jobs = new Jobs(dir());
  const server = jobs.start({ name: 'server', cwd: '/', command: 'exit 1' });
  jobs.start({ name: 'errors', cwd: '/', follow: server.id, match: 'error' });
  await until(() => latest(jobs, server).state === 'failed');
  jobs.due();
  assert.deepEqual(jobs.purge(), []);
  jobs.dispose();
});

test('dispose kills every running job', async () => {
  const jobs = new Jobs(dir());
  const a = jobs.start({ name: 'a', cwd: '/', command: 'sleep 30' });
  const b = jobs.start({ name: 'b', cwd: '/', command: 'sleep 31' });
  const pids = [a.pid!, b.pid!];
  jobs.dispose();
  await until(() => pids.every(pid => !alive(pid)));
  assert.throws(() => jobs.start({ name: 'c', cwd: '/', command: 'true' }), /session has ended/);
});

test('a job the person started says so to the agent', () => {
  const clock = createClock(0);
  const jobs = new Jobs(dir(), () => clock.now());
  assert.equal(specError({ every: 60_000 }), 'A reminder without a command needs a check instruction.');
  assert.equal(specError({ command: 'true' }), undefined);
  const job = jobs.start({ name: 'deploy', cwd: '/', every: 60_000, check: 'Is it green?', origin: 'person' });
  assert.equal(latest(jobs, job).history[0]!.text, 'started by you');
  clock.advance(60_000);
  assert.match(wakeText(jobs.due(), clock.now()), /The person started this job from \/jobs\./);
  jobs.dispose();
});

test('a job handed out never changes; the manager returns a new value instead', () => {
  const clock = createClock(0);
  const jobs = new Jobs(dir(), () => clock.now());
  const job = jobs.start({ name: 'r', cwd: '/', every: 60_000, check: 'look' });
  const paused = jobs.pause(job.id);
  assert.equal(job.paused, false);
  assert.equal(paused.paused, true);
  assert.equal(job.history.length, 1);
  assert.equal(paused.history[0]!.text, 'checks paused');
  assert.equal(jobs.get(job.id), paused);
  jobs.dispose();
});
