import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { SessionMessage } from './sessions.js';
import type { SessionSummary } from './store/types.js';
import type { CodexAsset } from './codex.js';
import type { CodingDesktopDetection } from './desktopDetection.js';

interface ReadJobs {
  'sessions.scan': { input: undefined; result: SessionSummary[] };
  'sessions.read': { input: { path: string }; result: SessionMessage[] };
  'sessions.export': { input: { summary?: SessionSummary; path?: string }; result: string };
  'codex.assets': { input: undefined; result: CodexAsset[] };
  'desktop.detect': { input: { exePath?: string }; result: CodingDesktopDetection };
}
type ReadJob = keyof ReadJobs;
interface JobWorker {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(): unknown;
  terminate(): Promise<number>;
}
interface JobRuntime {
  worker(job: ReadJob, input: unknown, context: unknown): JobWorker;
  context(): unknown;
  timeoutMs?: number;
  concurrency?: number;
}
interface Pending {
  start(): void;
  promise: Promise<unknown>;
}

/** Only explicit read operations enter workers; stores and mutations stay on their owning thread. */
export class ReadOnlyJobScheduler {
  private pending = new Map<string, Pending>();
  private queue: Pending[] = [];
  private active = 0;
  constructor(private readonly runtime: JobRuntime) {}

  run<K extends ReadJob>(job: K, input: ReadJobs[K]['input']): Promise<ReadJobs[K]['result']> {
    const context = this.runtime.context(), key = JSON.stringify([context, job, input]);
    const existing = this.pending.get(key);
    if (existing) return existing.promise.then(value => structuredClone(value)) as Promise<ReadJobs[K]['result']>;
    if (this.pending.size >= 24) return Promise.reject(new Error('本地扫描任务较多，请稍后重试'));
    let resolve!: (value: unknown) => void, reject!: (error: Error) => void;
    const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
    let worker: JobWorker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false, started = false, released = false;
    const release = () => {
      if (!started || released) return;
      released = true; this.active--;
      this.queue.shift()?.start();
    };
    const finish = (value?: unknown, error?: Error) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      this.pending.delete(key);
      const queued = this.queue.indexOf(entry); if (queued >= 0) this.queue.splice(queued, 1);
      if (error) reject(error); else resolve(value);
      if (worker) {
        worker.removeAllListeners(); worker.on('error', () => {}); worker.on('exit', release);
        // A synchronous OS probe can delay termination. Reject the caller now,
        // but retain the slot until the worker actually stops to bound live work.
        void worker.terminate().then(release, () => {});
      } else release();
    };
    const entry: Pending = { promise, start: () => {
      if (finished) return;
      started = true; this.active++;
      try {
        worker = this.runtime.worker(job, input, context);
        worker.on('message', message => {
          if (message?.ok === true) finish(message.value);
          else finish(undefined, new Error(typeof message?.error === 'string' ? message.error : '本地扫描失败，请重试'));
        });
        worker.on('error', () => finish(undefined, new Error('本地扫描进程不可用，请重试')));
        worker.on('exit', () => finish(undefined, new Error('本地扫描提前结束，请重试')));
      } catch { finish(undefined, new Error('无法启动本地扫描，请重试')); }
    } };
    this.pending.set(key, entry);
    // The deadline includes queue time, so an occupied slot cannot strand callers.
    timer = setTimeout(() => finish(undefined, new Error('本地扫描超时，请稍后重试')), this.runtime.timeoutMs ?? 35_000);
    if (this.active < (this.runtime.concurrency ?? 3)) entry.start(); else this.queue.push(entry);
    // A successful read is deliberately not cached: edits/repairs must be visible on refresh.
    return promise.then(value => structuredClone(value)) as Promise<ReadJobs[K]['result']>;
  }
}

const environmentKeys = ['AURORA_CLIENT_HOME', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_HOME'] as const;
const scheduler = new ReadOnlyJobScheduler({
  context: () => Object.fromEntries(environmentKeys.map(key => [key, process.env[key]])),
  worker: (job, input, context) => {
    const env = { ...process.env };
    for (const key of environmentKeys) {
      const value = (context as Record<string, string | undefined>)[key];
      if (value === undefined) delete env[key]; else env[key] = value;
    }
    return new Worker(path.join(__dirname, 'read-only-worker.cjs'), { workerData: { job, input }, env });
  },
});
export const scanSessionsAsync = () => scheduler.run('sessions.scan', undefined);
export const readSessionAsync = (file: string) => scheduler.run('sessions.read', { path: file });
export const exportSessionAsync = (input: { summary?: SessionSummary; path?: string }) => scheduler.run('sessions.export', input);
export const listCodexAssetsAsync = () => scheduler.run('codex.assets', undefined);
export const inspectDesktopAsync = (exePath?: string) => scheduler.run('desktop.detect', { exePath });
