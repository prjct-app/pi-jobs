import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import { outputOf, statusLines } from '../index.ts';

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const now = 1_000_000;
const review = {
  id: 'j1', name: 'pi-mcp-independent-security-review', state: 'done' as const, runs: 1, paused: false,
  command: `codex exec --sandbox read-only --cd /home/jj/Work/pi-mcp "${'Perform an independent review. '.repeat(40)}"`,
  cwd: '/home/jj/Work/pi-mcp', exitCode: 0, endedAt: now - 10_000, logFile: '/tmp/pi-jobs/j1.log', lines: 5026,
};
const text = ['j1 "pi-mcp-independent-security-review" · exit 0 · 10s ago', `command: ${review.command}`, 'cwd: /home/jj/Work/pi-mcp',
  'log: /tmp/pi-jobs/j1.log (5026 lines)', 'output:', '  3. **Medium — quadratic memory**', '     Every chunk copies the array.'].join('\n');

test('one job collapses to a single line: how it ended and how much it printed', () => {
  const lines = statusLines({ jobs: [review], one: true }, text, false, theme, now);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^✓ exit 0 · 10s ago · 5026 lines/);
  assert.doesNotMatch(lines[0], /codex|cwd|log/);
});

test('expanding shows a clipped command, where it runs, and the output tail', () => {
  const lines = statusLines({ jobs: [review], one: true }, text, true, theme, now);
  const command = lines.find(line => line.startsWith('$ '))!;
  assert.ok(command.length <= 122 && command.endsWith('…'));
  assert.ok(lines.includes('cwd /home/jj/Work/pi-mcp · log /tmp/pi-jobs/j1.log'));
  assert.deepEqual(lines.slice(-3), ['3. **Medium — quadratic memory**', '   Every chunk copies the array.', '… 5024 earlier lines in the log']);
});

test('the output tail is read back from the text the model received', () => {
  assert.deepEqual(outputOf(text), ['3. **Medium — quadratic memory**', '   Every chunk copies the array.']);
  assert.deepEqual(outputOf('j1 "x" · running'), []);
});

test('the job list collapses to counts and expands to one line per job', () => {
  const server = { ...review, id: 'j2', name: 'dev server', state: 'running' as const, command: 'npm run dev', endedAt: undefined, exitCode: undefined };
  const details = { jobs: [review, server], one: false };
  assert.match(statusLines(details, '', false, theme, now)[0], /^2 jobs · 1 done · 1 running/);
  assert.deepEqual(statusLines(details, '', true, theme, now).slice(1), ['✓ j1 pi-mcp-independent-security-review · exit 0 · 10s ago', '● j2 dev server · running']);
  assert.deepEqual(statusLines({ jobs: [], one: false }, '', false, theme, now), ['no jobs']);
});
