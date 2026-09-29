import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import { SYMBOL, ago, brand, completer, openForm, openPanel, panelText, row, setMode, type CommandOption, type FormValues, type PanelItem, type PanelSpec, type Tone } from '@prjct.app/pi-tui-kit';
import { Type } from 'typebox';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Jobs, MATCH_GAP, MAX_ACTIVE, MIN_EVERY, formatDuration, isActive, parseDuration, specError, wakeText, type Job, type JobSpec, type Wake } from './jobs.ts';

const WAKE = 'job-wake';
const TICK = 1_000;
/** What `w` watches for: the words most servers and tools print on a failure. */
const ERROR_PATTERN = 'error|exception|fatal|panic|traceback|unhandled|failed|ERR!';

const LOOK: Record<Job['state'], { symbol: string; tone: Tone; word: string }> = {
  running: { symbol: SYMBOL.active, tone: 'accent', word: 'running' },
  waiting: { symbol: SYMBOL.idle, tone: 'muted', word: 'waiting' },
  done: { symbol: SYMBOL.ok, tone: 'success', word: 'done' },
  failed: { symbol: SYMBOL.error, tone: 'error', word: 'failed' },
  stopped: { symbol: SYMBOL.idle, tone: 'dim', word: 'stopped' },
};

const look = (job: Job) => job.state === 'waiting' && job.follow ? { ...LOOK.waiting, word: `watching ${job.follow}` } : LOOK[job.state];

type JobView = Pick<Job, 'id' | 'name' | 'state' | 'checks' | 'exitCode' | 'signal' | 'pid' | 'logFile'>;
type WakeView = { reason: Wake['reason']; matched?: number; job: JobView };

const jobView = ({ id, name, state, checks, exitCode, signal, pid, logFile }: Job): JobView => ({ id, name, state, checks, exitCode, signal, pid, logFile });
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function meta(job: Job, now = Date.now()): string {
  if (isActive(job)) {
    const next = job.paused ? 'paused' : job.nextCheckAt ? `next ${formatDuration(Math.max(0, job.nextCheckAt - now))}` : job.match ? 'on match' : '';
    return [look(job).word, next].filter(Boolean).join(' · ');
  }
  const how = job.state === 'stopped' ? 'stopped' : job.signal ? `killed ${job.signal}` : `exit ${job.exitCode}`;
  return `${how} · ${ago(job.endedAt, now)}`;
}

function statusText(job: Job, lines: number, now = Date.now()): string {
  const out = [`${job.id} "${job.name}" · ${meta(job, now)}${job.runs > 1 ? ` · run ${job.runs}` : ''}`];
  if (job.command) out.push(`command: ${job.command}`, `cwd: ${job.cwd}`);
  if (job.follow) out.push(`follows: ${job.follow}`);
  if (job.match) out.push(`match: /${job.match}/`);
  if (job.every) out.push(`every: ${formatDuration(job.every)} · checks: ${job.checks}${job.maxChecks ? `/${job.maxChecks}` : ''}${job.paused ? ' · paused' : ''}`);
  if (job.check) out.push(`check: ${job.check}`);
  if (job.logFile) out.push(`log: ${job.logFile} (${job.lines} lines)`);
  const tail = job.tail.slice(-lines);
  if (tail.length) out.push('output:', ...tail.map(line => `  ${line}`));
  return out.join('\n');
}

const HELP = [
  'Background jobs keep work running while you and the agent do other things. The agent is woken, only when it is idle, when a job needs it.',
  '',
  'What a job is made of',
  '  command   Runs something: a dev server, a long build or test run. The agent hears when it exits.',
  `  match     Wakes the agent when a new output line matches, e.g. error|exception, with the lines after it. At most once every ${formatDuration(MATCH_GAP)}.`,
  `  every     Wakes the agent on an interval (${formatDuration(MIN_EVERY)} minimum), e.g. to re-check a deploy. Skipped when nothing new was printed.`,
  '  follow    Reads another job\'s output instead of running a command: a watcher you can pause, edit or delete without touching the server.',
  '  check     What the agent does when woken, in plain words.',
  '',
  'Examples',
  '  Dev server              command "npm run dev"',
  '  Its errors              follow j1 · match "error|exception" · check "Find the cause and fix it."   (w on the server does this)',
  '  Its logs every 10m      follow j1 · every 10m · check "Anything unusual in these logs? Say so only if there is."',
  '  A deploy                every 5m · check "Is the staging deploy green? Tell me when it is."',
  '  Tests you don\'t wait on command "npm test"   (the agent hears the result when it ends)',
  '',
  'Keys in /jobs   n new · w watch errors · c check now · p pause/resume · e edit · r restart · x stop · d delete · D purge finished · X stop all',
  'Commands        /jobs new · watch <id> · check <id> · pause <id> · resume <id> · restart <id> · stop <id|all> · delete <id> · purge',
].join('\n');

type Draft = Partial<Record<'name' | 'command' | 'follow' | 'match' | 'every' | 'check' | 'max_checks' | 'cwd', string>>;
type Flow = { next?: { kind: 'new'; draft?: Draft } | { kind: 'edit'; id: string } };

const draftOf = (job: Job): Draft => ({
  name: job.name,
  command: job.command,
  follow: job.follow,
  match: job.match,
  every: job.every ? formatDuration(job.every) : undefined,
  check: job.check,
  max_checks: job.maxChecks ? String(job.maxChecks) : undefined,
  cwd: job.cwd,
});

const watchDraft = (job: Job): Draft => ({
  name: `${job.name} errors`,
  follow: job.id,
  match: ERROR_PATTERN,
  check: 'Read the error and the lines after it. Find the cause and fix it if it is in this project; otherwise say what is wrong.',
});

export default function piJobs(pi: ExtensionAPI): void {
  const state: { jobs?: Jobs; ctx?: ExtensionContext; ticker?: NodeJS.Timeout; off?: () => void } = {};

  const jobs = (): Jobs => {
    if (!state.jobs) throw new Error('No active session.');
    return state.jobs;
  };

  const publish = (): void => {
    if (!state.ctx || !state.jobs) return;
    const active = state.jobs.active().length;
    setMode(state.ctx, 'jobs', active ? `jobs ${active}` : undefined);
  };

  /** Tell the agent only when it is idle: a check never interrupts a turn. */
  const tick = (): void => {
    const ctx = state.ctx, current = state.jobs;
    if (!ctx || !current) return;
    if (current.hasDue() && ctx.isIdle() && !ctx.hasPendingMessages()) {
      const wakes = current.due();
      if (wakes.length) {
        pi.sendMessage<{ wakes: WakeView[] }>(
          { customType: WAKE, content: wakeText(wakes), display: true, details: { wakes: wakes.map(w => ({ reason: w.reason, matched: w.matched, job: jobView(w.job) })) } },
          { triggerTurn: true, deliverAs: 'followUp' },
        );
      }
    }
    if (!current.active().length && !current.hasDue()) stopTicking();
  };

  const startTicking = (): void => {
    if (state.ticker) return;
    state.ticker = setInterval(tick, TICK);
    state.ticker.unref();
  };
  const stopTicking = (): void => {
    if (state.ticker) clearInterval(state.ticker);
    state.ticker = undefined;
  };

  // Jobs run in their own process groups, so a Pi that dies without a
  // session_shutdown would leave them behind. Exit handlers must be sync.
  const onExit = (): void => state.jobs?.dispose();

  const close = (): void => {
    process.off('exit', onExit);
    stopTicking();
    state.off?.();
    state.off = undefined;
    state.jobs?.dispose();
    state.jobs = undefined;
    if (state.ctx) setMode(state.ctx, 'jobs', undefined);
  };

  pi.on('session_start', async (_event, ctx) => {
    close();
    state.ctx = ctx;
    state.jobs = new Jobs(join(tmpdir(), 'pi-jobs', `${process.pid}-${Date.now().toString(36)}`));
    state.off = state.jobs.onChange(() => { publish(); startTicking(); });
    process.once('exit', onExit);
  });

  pi.on('session_shutdown', async () => close());

  pi.registerTool({
    name: 'job_start',
    label: 'Start a background job',
    description: 'Start a background job in this session; you are woken about it only when you are idle. '
      + 'Use it only for work that must keep running while you do other things: a dev server, or a build or test run too long to wait for. '
      + 'Run anything that finishes in a minute or two with bash instead.\n'
      + 'command runs detached in its own process group. When it exits you are woken with the exit code and its last output, so never add every just to learn that it finished.\n'
      + 'A server needs only a command. Do not add every or a check to see that it is still up: a crash wakes you anyway. '
      + 'To hear about its errors, add match (e.g. "error|exception") and you are woken with each matching line and the lines after it.\n'
      + `every wakes you on an interval, for something that changes without printing, such as a remote deploy or CI run you re-check yourself. Each wake costs a full turn: use the longest interval that works (minimum ${formatDuration(MIN_EVERY)}). A job that reads output is not woken when nothing new was printed.\n`
      + 'check is what you do when woken, in plain words for yourself. It is not a shell command.\n'
      + 'follow reads another job\'s output instead of running a command, so a watcher with its own match, every and check can be stopped without touching the server.\n'
      + `One job per command: if a job already runs it, use job_restart. At most ${MAX_ACTIVE} active jobs; all end with the session.`,
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 60, description: 'Short label, e.g. "api dev server" or "deploy staging".' }),
      command: Type.Optional(Type.String({ minLength: 1, description: 'Shell command run with bash -c in its own process group, e.g. "npm run dev".' })),
      cwd: Type.Optional(Type.String({ description: 'Working directory; defaults to the session cwd.' })),
      follow: Type.Optional(Type.String({ description: 'Id of a job with a command (e.g. "j1") whose output this job reads instead of running its own.' })),
      match: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: `Case-insensitive regular expression tested on each new output line, e.g. "error|exception|failed". A match wakes you with the line and the few after it, at most once every ${formatDuration(MATCH_GAP)}.` })),
      every: Type.Optional(Type.String({ description: `Wake interval such as "5m" or "1h"; minimum ${formatDuration(MIN_EVERY)}. Omit it for servers and for commands you only need to hear back from when they exit.` })),
      check: Type.Optional(Type.String({ maxLength: 2000, description: 'What to do when woken, in plain words, e.g. "Find the cause of the error and fix it." Not a shell command. Required for a reminder with neither command nor follow.' })),
      max_checks: Type.Optional(Type.Integer({ minimum: 1, description: 'End the checks after this many wakes.' })),
    }, { additionalProperties: false }),
    execute: async (_id, input, _signal, _onUpdate, ctx) => {
      const every = input.every === undefined ? undefined : parseDuration(input.every);
      if (input.every !== undefined && every === undefined) throw new Error(`"${input.every}" is not an interval. Use forms like 5m, 1h, 1h30m.`);
      const cwd = input.cwd ? (isAbsolute(input.cwd) ? input.cwd : resolve(ctx.cwd, input.cwd)) : ctx.cwd;
      const job = jobs().start({ name: oneLine(input.name), command: input.command, cwd, follow: input.follow, every, match: input.match, check: input.check, maxChecks: input.max_checks });
      const parts = [`Started ${job.id} "${job.name}".`];
      if (job.pid) parts.push(`pid ${job.pid}, log ${job.logFile}.`);
      if (job.follow) parts.push(`It follows ${job.follow}.`);
      if (job.command) parts.push('You are woken when it exits.');
      if (job.match) parts.push(`A new line matching /${job.match}/ wakes you.`);
      if (job.every) parts.push(`First check in ${formatDuration(job.every)}${job.command || job.follow ? ', skipped when nothing new was printed' : ''}.`);
      return { content: [{ type: 'text', text: parts.join(' ') }], details: { job: jobView(job) } };
    },
    renderCall(args, theme) {
      const how = args?.follow ? `follows ${args.follow}` : args?.every ? `every ${args.every}` : args?.match ? 'on match' : args?.command ? 'until exit' : '';
      return row(theme, { symbol: SYMBOL.active, tone: 'accent', verb: 'JOB', target: `start · ${oneLine(String(args?.name ?? ''))}`, meta: how });
    },
    renderResult(result, _options, theme) {
      const job = (result.details as { job?: JobView } | undefined)?.job;
      if (!job) return new Text(theme.fg('error', String((result.content[0] as { text?: string } | undefined)?.text ?? '')), 2, 0);
      return new Text(theme.fg('dim', `${job.id}${job.pid ? ` · pid ${job.pid}` : ''}${job.logFile ? ` · ${job.logFile}` : ''}`), 2, 0);
    },
  });

  pi.registerTool({
    name: 'job_status',
    label: 'Background job status',
    description: 'List this session\'s background jobs, or show one job with the tail of its output.',
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: 'Job id such as "j2". Omit to list every job.' })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 400, description: 'Output lines to show for one job. Default 40.' })),
    }, { additionalProperties: false }),
    execute: async (_id, input) => {
      const all = jobs();
      if (input.id) return { content: [{ type: 'text', text: statusText(all.find(input.id), input.lines ?? 40) }], details: undefined };
      const list = all.list();
      const text = list.length ? list.map(job => `${job.id} "${job.name}" · ${meta(job)}`).join('\n') : 'No background jobs in this session.';
      return { content: [{ type: 'text', text }], details: undefined };
    },
    renderCall(args, theme) {
      return row(theme, { symbol: SYMBOL.idle, tone: 'muted', verb: 'JOB', target: args?.id ? `status · ${args.id}` : 'status' });
    },
  });

  pi.registerTool({
    name: 'job_restart',
    label: 'Restart a background job',
    description: 'Restart a background job in place: same id, and the jobs that follow it keep following. '
      + 'The old process group is gone before the new one starts, so its port is free. '
      + 'Use it when a server must pick up something it only reads at start, such as env or config. Give command to replace the command.',
    parameters: Type.Object({
      id: Type.String({ description: 'Job id such as "j2".' }),
      command: Type.Optional(Type.String({ minLength: 1, description: 'New shell command; omit to run the same one.' })),
    }, { additionalProperties: false }),
    execute: async (_id, input) => {
      const job = await jobs().restart(input.id, 'restarted by the agent', input.command ? { command: input.command } : {});
      return { content: [{ type: 'text', text: `Restarted ${job.id} "${job.name}" (run ${job.runs}).${job.pid ? ` pid ${job.pid}, log ${job.logFile}.` : ''}` }], details: { job: jobView(job) } };
    },
    renderCall(args, theme) {
      const job = args?.id ? state.jobs?.get(args.id) : undefined;
      return row(theme, { symbol: SYMBOL.active, tone: 'accent', verb: 'JOB', target: `restart · ${job ? job.name : String(args?.id ?? '')}` });
    },
  });

  pi.registerTool({
    name: 'job_stop',
    label: 'Stop a background job',
    description: 'Stop a background job: its process group is terminated, its checks end, and the jobs that follow it stop too. '
      + 'Stop a job as soon as it no longer needs watching; leave a server the person is using running unless they ask.',
    parameters: Type.Object({ id: Type.String({ description: 'Job id such as "j2".' }) }, { additionalProperties: false }),
    execute: async (_id, input) => {
      const job = jobs().stop(input.id, 'stopped by the agent');
      return { content: [{ type: 'text', text: `${job.id} "${job.name}" · ${meta(job)}.` }], details: undefined };
    },
    renderCall(args, theme) {
      const job = args?.id ? state.jobs?.get(args.id) : undefined;
      return row(theme, { symbol: SYMBOL.idle, tone: 'dim', verb: 'JOB', target: `stop · ${job ? job.name : String(args?.id ?? '')}` });
    },
  });

  pi.registerMessageRenderer<{ wakes?: WakeView[] }>(WAKE, (message, { expanded }, theme) => {
    const wakes = message.details?.wakes ?? [];
    const failed = wakes.some(w => w.reason === 'exit' && w.job.state === 'failed');
    const matched = wakes.some(w => w.matched);
    const head = row(theme, {
      symbol: failed ? SYMBOL.error : wakes.some(w => w.reason === 'exit') ? SYMBOL.ok : SYMBOL.active,
      tone: failed ? 'error' : matched ? 'warning' : 'accent',
      verb: 'JOB',
      target: wakes.map(w => w.job.name).join(', ') || 'background job',
      meta: wakes.map(w => w.reason === 'exit' ? (w.job.signal ? `killed ${w.job.signal}` : `exit ${w.job.exitCode}`) : w.matched ? `${w.matched} matched` : `check ${w.job.checks}`).join(' · '),
      metaTone: failed ? 'error' : matched ? 'warning' : 'dim',
    });
    if (!expanded) return head;
    const body = new Container();
    body.addChild(head);
    body.addChild(new Text(theme.fg('toolOutput', typeof message.content === 'string' ? message.content : ''), 2, 0));
    return body;
  });

  const jobOf = (item: PanelItem | undefined): Job | undefined => item ? state.jobs?.get(item.id) : undefined;
  const activeJob = (item: PanelItem | undefined): boolean => {
    const job = jobOf(item);
    return !!job && isActive(job);
  };

  const panel = (flow: Flow = {}, initial?: string): PanelSpec => ({
    title: 'Jobs',
    summary: () => {
      const list = state.jobs?.list() ?? [];
      const finished = list.filter(job => !isActive(job)).length;
      return [`${list.filter(isActive).length} active`, finished && `${finished} finished`].filter(Boolean).join(' · ');
    },
    items: () => (state.jobs?.list() ?? []).slice().reverse().map((job): PanelItem => ({
      id: job.id,
      label: job.name,
      symbol: look(job).symbol,
      tone: look(job).tone,
      meta: meta(job),
      search: `${job.id} ${job.command ?? ''} ${job.check ?? ''} ${job.match ?? ''}`,
    })),
    detail: item => {
      const job = state.jobs?.get(item.id);
      if (!job) return { title: item.label };
      const source = job.follow ? state.jobs?.get(job.follow) : undefined;
      const watchers = state.jobs?.followers(job.id) ?? [];
      const fields = [
        { label: 'state', value: meta(job), tone: look(job).tone },
        { label: 'id', value: [job.id, job.pid && `pid ${job.pid}`, job.runs > 1 && `run ${job.runs}`].filter(Boolean).join(' · ') },
        ...(job.command ? [{ label: 'command', value: job.command }, { label: 'cwd', value: job.cwd }] : []),
        ...(job.follow ? [{ label: 'follows', value: source ? `${source.id} · ${source.name} · ${meta(source)}` : `${job.follow} (deleted)` }] : []),
        ...(watchers.length ? [{ label: 'followed by', value: watchers.map(w => `${w.id} ${w.name}`).join(', ') }] : []),
        ...(job.match ? [{ label: 'match', value: `/${job.match}/ · wakes at most every ${formatDuration(MATCH_GAP)}` }] : []),
        ...(job.every ? [{ label: 'every', value: `${formatDuration(job.every)}${job.command || job.follow ? ', when there is new output' : ''}` }] : []),
        ...(job.every || job.match ? [{ label: 'wakes', value: `${job.checks}${job.maxChecks ? ` of ${job.maxChecks}` : ''}${job.paused ? ' · paused' : ''}`, tone: (job.paused ? 'warning' : undefined) as Tone | undefined }] : []),
        ...(job.check ? [{ label: 'check', value: job.check }] : []),
        { label: 'started', value: ago(job.startedAt) },
        ...(job.logFile ? [{ label: 'log', value: job.logFile }] : []),
      ];
      const sections: { title: string; lines: string[] }[] = [];
      if (job.hits.length) sections.push({ title: `Matched, not yet reported · ${plural(job.hitCount, 'line')}`, lines: job.hits });
      if (job.command || job.follow) sections.push({ title: `${job.follow ? `Output of ${job.follow}` : 'Output'} · ${job.lines} lines`, lines: job.tail.length ? job.tail.slice(-60) : ['(no output yet)'] });
      sections.push({ title: 'History', lines: job.history.map(entry => `${ago(entry.at)}  ${entry.text}`) });
      return { title: job.name, subtitle: look(job).word, subtitleTone: look(job).tone, fields, sections };
    },
    actions: [
      {
        key: 'n', label: 'New',
        run: (_item, control) => { flow.next = { kind: 'new' }; control.close(); },
      },
      {
        key: 'w', label: 'Watch errors', when: item => !!jobOf(item)?.command,
        run: (item, control) => { flow.next = { kind: 'new', draft: watchDraft(jobOf(item)!) }; control.close(); },
      },
      {
        key: 'c', label: 'Check', when: activeJob,
        run: (item, control) => { jobs().checkNow(item!.id); control.notice(`${item!.label}: the agent checks it when idle`, 'accent'); },
      },
      {
        key: 'p', label: item => jobOf(item)?.paused ? 'Resume' : 'Pause',
        when: item => { const job = jobOf(item); return !!job && isActive(job) && !!(job.every || job.match); },
        run: (item, control) => {
          const job = jobOf(item)!;
          if (job.paused) { jobs().resume(job.id); control.notice(`${job.name}: checks resumed`, 'accent'); }
          else { jobs().pause(job.id); control.notice(`${job.name}: checks paused; an exit is still reported`, 'muted'); }
        },
      },
      {
        key: 'e', label: item => activeJob(item) ? 'Edit' : 'Edit & run', when: item => !!jobOf(item),
        run: (item, control) => { flow.next = { kind: 'edit', id: item!.id }; control.close(); },
      },
      {
        key: 'r', label: item => activeJob(item) ? 'Restart' : 'Run again', confirm: true, when: item => !!jobOf(item),
        run: async (item, control) => {
          const job = await jobs().restart(item!.id, 'restarted by you');
          control.notice(`${job.name} restarted · run ${job.runs}`, 'accent');
        },
      },
      {
        key: 'x', label: 'Stop', confirm: true, when: activeJob,
        run: (item, control) => {
          const watchers = jobs().followers(item!.id).length;
          jobs().stop(item!.id, 'stopped by you');
          control.notice(`${item!.label} stopped${watchers ? ` with ${plural(watchers, 'watcher')}` : ''}`, 'muted');
        },
      },
      {
        key: 'd', label: 'Delete', confirm: true, when: item => !!jobOf(item),
        run: (item, control) => { jobs().remove(item!.id, 'deleted by you'); control.notice(`${item!.label} deleted with its log`, 'muted'); },
      },
      {
        key: 'D', label: 'Purge finished', confirm: true, bulk: true, when: () => !!state.jobs?.purgeable().length,
        run: (_item, control) => {
          const gone = jobs().purge();
          control.notice(`Purged ${plural(gone.length, 'finished job')}`, 'muted');
        },
      },
      {
        key: 'X', label: 'Stop all', confirm: true, bulk: true, when: () => (state.jobs?.active().length ?? 0) > 1,
        run: (_item, control) => { const gone = jobs().stopAll('stopped by you'); control.notice(`Stopped ${plural(gone.length, 'job')}`, 'muted'); },
      },
    ],
    empty: 'No background jobs. n starts one: a dev server, a watcher for its errors, or a check on a deploy every few minutes. /jobs help explains each part.',
    subscribe: changed => state.jobs?.onChange(changed) ?? (() => {}),
    refreshMs: 1_000,
    initial,
  });

  const parse = (values: FormValues, ctx: ExtensionContext, origin?: JobSpec['origin']): JobSpec => ({
    name: oneLine(values.name ?? ''),
    command: values.command || undefined,
    cwd: values.cwd ? (isAbsolute(values.cwd) ? values.cwd : resolve(ctx.cwd, values.cwd)) : ctx.cwd,
    follow: values.follow || undefined,
    every: values.every ? parseDuration(values.every) : undefined,
    match: values.match || undefined,
    check: values.check || undefined,
    maxChecks: values.max_checks ? Number(values.max_checks) : undefined,
    origin,
  });

  /** The docked job form, for a new job or an existing one. Returns the job id, or undefined when cancelled. */
  const jobForm = async (ctx: ExtensionContext, target: { draft?: Draft; id?: string }): Promise<string | undefined> => {
    const editing = target.id ? state.jobs?.get(target.id) : undefined;
    const draft = editing ? draftOf(editing) : target.draft ?? {};
    const live = (spec: JobSpec): boolean => !!editing && isActive(editing)
      && (spec.command ?? '') === (editing.command ?? '') && (spec.follow ?? '') === (editing.follow ?? '')
      && (!spec.command || spec.cwd === editing.cwd);
    const values = await openForm(ctx as unknown as Parameters<typeof openForm>[0], {
      title: editing ? `Edit ${editing.id}` : 'New job',
      message: editing
        ? (isActive(editing) ? 'Changing command, cwd or follow restarts it under the same id; the rest applies without touching the process.' : 'Saving runs it again under the same id.')
        : 'Runs in the background of this session. The agent is woken when the command ends, when a line matches, and on every check. /jobs help has examples.',
      submitLabel: editing ? 'save' : 'create',
      fields: [
        { id: 'name', label: 'name', required: true, value: draft.name, placeholder: 'dev server', hint: 'A short label for the list and the transcript.' },
        { id: 'command', label: 'command', value: draft.command, placeholder: 'npm run dev', hint: 'Runs with bash -c in its own process group. Leave it empty for a watcher (follow) or a plain reminder.' },
        { id: 'follow', label: 'follow', value: draft.follow, placeholder: 'j1', hint: 'Read another job\'s output instead of running a command. With match, it watches a server\'s errors.' },
        { id: 'match', label: 'match', value: draft.match, placeholder: 'error|exception|failed', hint: `Case-insensitive regex. A new line that matches wakes the agent with it and the lines after, at most every ${formatDuration(MATCH_GAP)}.` },
        { id: 'every', label: 'every', value: draft.every, placeholder: '5m', hint: `Wake the agent on this interval (${formatDuration(MIN_EVERY)} minimum), skipped when nothing new was printed. Leave it empty for servers.` },
        { id: 'check', label: 'check', value: draft.check, placeholder: 'Find the cause of the error and fix it.', hint: 'What the agent does when woken, in plain words. Required for a reminder.' },
        { id: 'max_checks', label: 'max checks', value: draft.max_checks, placeholder: 'no limit', hint: 'End the checks after this many wakes.' },
        { id: 'cwd', label: 'cwd', value: draft.cwd ?? ctx.cwd, hint: 'Working directory for the command.' },
      ],
      validate: values => {
        if (values.every && parseDuration(values.every) === undefined) return `"${values.every}" is not an interval. Use 5m, 1h or 1h30m.`;
        if (values.max_checks && !(Number.isInteger(Number(values.max_checks)) && Number(values.max_checks) > 0)) return 'max checks must be a whole number above 0.';
        if (!state.jobs) return 'No active session.';
        const spec = parse(values, ctx);
        return live(spec) ? specError(spec) : state.jobs.whyNot(spec, editing?.id);
      },
    });
    if (!values) return undefined;
    if (!editing) {
      const job = jobs().start(parse(values, ctx, 'person'));
      ctx.ui.notify(`${job.id} "${job.name}" started${job.every ? ` · first check in ${formatDuration(job.every)}` : ''}.`, 'info');
      return job.id;
    }
    const spec = parse(values, ctx, editing.origin);
    if (live(spec)) {
      jobs().edit(editing.id, { name: spec.name, every: spec.every, match: spec.match, check: spec.check, maxChecks: spec.maxChecks }, 'edited by you');
      ctx.ui.notify(`${editing.id} "${editing.name}" saved.`, 'info');
    } else {
      await jobs().restart(editing.id, 'edited by you', spec);
      ctx.ui.notify(`${editing.id} "${editing.name}" saved and running again.`, 'info');
    }
    return editing.id;
  };

  const ids = (keep: (job: Job) => boolean = () => true) => (): CommandOption[] =>
    (state.jobs?.list() ?? []).filter(keep).map(job => ({ value: job.id, description: `${job.name} · ${meta(job)}` }));

  const verbs: CommandOption[] = [
    { value: 'new', description: 'create a job in the form' },
    { value: 'watch', description: 'watch a job\'s output for errors', options: ids(job => !!job.command) },
    { value: 'check', description: 'wake the agent about a job now', options: ids(isActive) },
    { value: 'pause', description: 'hold a job\'s checks; the process keeps running', options: ids(job => isActive(job) && !job.paused) },
    { value: 'resume', description: 'start a paused job\'s checks again', options: ids(job => job.paused && isActive(job)) },
    { value: 'restart', description: 'run a job again under the same id', options: ids() },
    { value: 'stop', description: 'stop a job, or all of them', options: () => [{ value: 'all', description: 'stop every active job' }, ...ids(isActive)()] },
    { value: 'delete', description: 'stop a job and delete it with its log', options: ids() },
    { value: 'purge', description: 'delete every finished job' },
    { value: 'help', description: 'what each part of a job is for, with examples' },
  ];

  /** One /jobs verb from the editor. Returns what happened. */
  const runVerb = async (verb: string, id: string): Promise<string> => {
    const all = jobs();
    if (verb === 'purge') {
      const gone = all.purge();
      return gone.length ? `Purged ${plural(gone.length, 'finished job')}: ${gone.map(job => job.id).join(', ')}.` : 'Nothing to purge: no finished job the agent has already heard about.';
    }
    if (verb === 'stop' && id === 'all') return `Stopped ${plural(all.stopAll('stopped by you').length, 'job')}.`;
    if (!verbs.some(option => option.value === verb)) throw new Error(`Unknown: /jobs ${verb}. /jobs help lists every verb.`);
    if (!id) throw new Error(`Usage: /jobs ${verb} <id>. /jobs help lists every verb.`);
    const job = all.find(id);
    if (verb === 'check') { if (!isActive(job)) throw new Error(`${id} is not active.`); all.checkNow(id); return `${id} "${job.name}": the agent checks it when idle.`; }
    if (verb === 'pause') { all.pause(id); return `${id} "${job.name}": checks paused.`; }
    if (verb === 'resume') { all.resume(id); return `${id} "${job.name}": checks resumed.`; }
    if (verb === 'restart') { await all.restart(id, 'restarted by you'); return `${id} "${job.name}" restarted · run ${job.runs}.`; }
    if (verb === 'stop') { all.stop(id, 'stopped by you'); return `${id} "${job.name}" stopped.`; }
    if (verb === 'delete') { all.remove(id, 'deleted by you'); return `${id} "${job.name}" deleted with its log.`; }
    throw new Error(`Unknown: /jobs ${verb}. /jobs help lists every verb.`);
  };

  pi.registerCommand('jobs', {
    description: brand('background jobs: servers, watchers, checks · new | watch | restart | stop | delete | purge | help'),
    getArgumentCompletions: completer(verbs),
    handler: async (args, ctx) => {
      const [verb = '', id = ''] = args.trim().split(/\s+/);
      const tui = ctx.hasUI && ctx.mode === 'tui';
      if (verb === 'help') { ctx.ui.notify(HELP, 'info'); return; }
      let next: Flow['next'];
      if (verb === 'new') next = { kind: 'new' };
      else if (verb === 'watch') {
        try {
          const job = jobs().find(id);
          if (!job.command) throw new Error(`${id} runs no command to watch.`);
          next = { kind: 'new', draft: watchDraft(job) };
        } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); return; }
      } else if (verb) {
        try { ctx.ui.notify(await runVerb(verb, id), 'info'); }
        catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
        return;
      }
      if (!tui) {
        ctx.ui.notify(next ? 'The job form needs the TUI; ask the agent to start the job instead.' : panelText(panel()), next ? 'warning' : 'info');
        return;
      }
      // The form and the panel take turns in the dock: the panel closes to open
      // the form, and opens again on the job the form made or changed.
      let selected: string | undefined;
      // `/jobs new` cancelled goes back to the editor; a form opened from the panel goes back to the panel.
      let direct = !!next;
      for (;;) {
        if (next) {
          let made: string | undefined;
          try { made = await jobForm(ctx, next.kind === 'edit' ? { id: next.id } : { draft: next.draft }); }
          catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
          if (!made && direct) return;
          direct = false;
          selected = made ?? (next.kind === 'edit' ? next.id : selected);
        }
        const flow: Flow = {};
        await openPanel(ctx, panel(flow, selected));
        if (!flow.next) return;
        next = flow.next;
      }
    },
  });
}
