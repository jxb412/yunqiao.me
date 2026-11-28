import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { AGENT_ADAPTERS, getDetectionContext, type AgentDetection } from './adapters.js';
import { inspectDesktopAsync } from '../readOnlyJobs.js';
import type { CodingDesktopDetection } from '../desktopDetection.js';

type Detections = Record<string, AgentDetection>;
interface DetectionContext { revision: number; exePath?: string; isolatedHome?: string; codexHome?: string; claudeHome?: string; geminiHome?: string }
interface DetectionWorker {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners(): unknown;
  terminate(): Promise<number>;
}
interface DetectionRuntime {
  context(): DetectionContext;
  fallback(): Detections;
  worker(context: DetectionContext): DetectionWorker;
  now?(): number;
  timeoutMs?: number;
  successTtlMs?: number;
  failureTtlMs?: number;
}
interface Pending {
  key: string;
  promise: Promise<Detections>;
  resolve(value: Detections | PromiseLike<Detections>): void;
  worker?: DetectionWorker;
  timer?: ReturnType<typeof setTimeout>;
  partial: Detections;
  fallback: Detections;
}
const failedMessage = '客户端检测暂未完成，请稍后点击“重新检测”。现有连接配置保持不变。';

/** Trusted runtime seams keep scheduling tests independent of the actual host. */
export class AsyncDetectionScheduler {
  private cache?: { key: string; expiresAt: number; data: Detections };
  private pending?: Pending;
  private listeners = new Set<() => void>();
  constructor(private readonly runtime: DetectionRuntime) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private key(context: DetectionContext): string { return JSON.stringify(context); }
  private now(): number { return this.runtime.now?.() ?? Date.now(); }
  private stop(pending: Pending): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.worker?.removeAllListeners();
    pending.worker?.on('error', () => {});
    // A worker may be waiting for a bounded synchronous OS probe. Termination
    // must never hold up the main event loop or the caller's timeout result.
    if (pending.worker) void pending.worker.terminate().catch(() => {});
  }
  private fallback(pending: Pending, detecting: boolean): Detections {
    return Object.fromEntries(Object.entries(pending.fallback).map(([id, value]) => [id,
      pending.partial[id] || { ...value, detecting, ...(!detecting ? { detectionError: failedMessage } : {}) },
    ]));
  }
  private finish(pending: Pending, data?: Detections): void {
    if (this.pending !== pending) return;
    if (this.key(this.runtime.context()) !== pending.key) {
      // A changed program path/reset supersedes both the cache and in-flight
      // replies. Awaiting callers follow the new scan instead of seeing old data.
      pending.resolve(this.read());
      return;
    }
    this.pending = undefined;
    this.stop(pending);
    const result = data || this.fallback(pending, false);
    this.cache = { key: pending.key, expiresAt: this.now() + (data ? this.runtime.successTtlMs ?? 60_000 : this.runtime.failureTtlMs ?? 30_000), data: result };
    pending.resolve(result);
    for (const listener of this.listeners) { try { listener(); } catch { /* Optional UI refresh must not discard a completed scan. */ } }
  }
  read(options: { background?: boolean } = {}): Promise<Detections> {
    const context = this.runtime.context(), key = this.key(context);
    if (this.cache?.key === key && this.now() < this.cache.expiresAt) return Promise.resolve(structuredClone(this.cache.data));
    if (this.pending?.key !== key) {
      const previous = this.pending;
      if (previous) this.stop(previous);
      let resolve!: Pending['resolve'];
      const promise = new Promise<Detections>(done => { resolve = done; });
      const pending: Pending = { key, promise, resolve, partial: {}, fallback: this.runtime.fallback() };
      this.pending = pending;
      if (previous) previous.resolve(promise);
      try {
        const worker = this.runtime.worker(context); pending.worker = worker;
        worker.on('message', message => {
          if (this.pending !== pending) return;
          if (message?.type === 'progress' && typeof message.id === 'string' && Object.hasOwn(pending.fallback, message.id)
            && message.detection && typeof message.detection.installed === 'boolean' && typeof message.detection.configured === 'boolean') {
            pending.partial[message.id] = message.detection;
          } else if (message?.type === 'complete' && message.data && typeof message.data === 'object'
            && Object.keys(pending.fallback).every(id => typeof message.data[id]?.installed === 'boolean' && typeof message.data[id]?.configured === 'boolean')) {
            this.finish(pending, message.data);
          } else if (message?.type !== 'progress') this.finish(pending);
        });
        worker.on('error', () => this.finish(pending));
        worker.on('exit', () => this.finish(pending));
        pending.timer = setTimeout(() => this.finish(pending), this.runtime.timeoutMs ?? 35_000);
      } catch { this.finish(pending); }
    }
    const pending = this.pending;
    if (!pending) return Promise.resolve(structuredClone(this.cache!.data));
    return options.background ? Promise.resolve(this.fallback(pending, true)) : pending.promise.then(data => structuredClone(data));
  }
}

function lightweightDetection(): Detections {
  return Object.fromEntries(AGENT_ADAPTERS.map(adapter => {
    // configPaths constructs known locations; adapter.detect may invoke OS
    // probes and is intentionally restricted to the worker on this path.
    let configPath: string | undefined, configured = false;
    try { const files = adapter.configPaths(); configPath = files[0]; configured = files.some(file => fs.existsSync(file)); } catch { /* Optional configuration discovery. */ }
    return [adapter.id, { installed: false, configured, configPath, detecting: true }];
  }));
}
const scheduler = new AsyncDetectionScheduler({
  context: () => ({ ...getDetectionContext(), isolatedHome: process.env.AURORA_CLIENT_HOME, codexHome: process.env.CODEX_HOME, claudeHome: process.env.CLAUDE_CONFIG_DIR, geminiHome: process.env.GEMINI_CLI_HOME }),
  fallback: lightweightDetection,
  worker: context => new Worker(path.join(__dirname, 'detection-worker.cjs'), { workerData: { exePath: context.exePath } }),
});
export const detectAllAsync = (options: { background?: boolean } = {}): Promise<Detections> => scheduler.read(options);
export const onDetectionUpdated = (listener: () => void): (() => void) => scheduler.subscribe(listener);

/** Share the normal client scan; a separate extension path and explicit reconnect need their own fresh probe. */
export async function detectDesktopAsync(exePath?: string, fresh = false): Promise<CodingDesktopDetection> {
  const configured = getDetectionContext().exePath;
  if (fresh || (exePath || '') !== (configured || '')) return inspectDesktopAsync(exePath);
  const detected = (await detectAllAsync())['chatgpt-desktop'];
  return detected?.desktopDetails || { installed: false, supportsCodexConfig: false, evidence: [], detectionError: detected?.detectionError || failedMessage };
}
