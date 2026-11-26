import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWrite } from './agents/configFiles.js';
import { runningCodingClients } from './clientProcesses.js';
import { getDetectionContext } from './agents/adapters.js';
import { detectDesktopAsync } from './agents/detectionAsync.js';

export const runFile = promisify(execFile);
export const historyStorageMessages = {
  CLIENT_HISTORY_STORAGE_FULL: '历史备份空间不足，未提交新的客户端配置。请清理磁盘空间后重试。',
  CLIENT_HISTORY_STORAGE_DENIED: '无法读写历史备份目录，未提交新的客户端配置。请检查目录权限或文件占用后重试。',
  CLIENT_HISTORY_STORAGE_BUSY: '历史数据库仍被其他程序占用，未提交新的客户端配置。请完全退出客户端后重试。',
  CLIENT_HISTORY_STORAGE_IO: '读取或保存历史备份失败，未提交新的客户端配置。请检查磁盘与备份目录是否可用后重试。',
} as const;
export type HistoryStorageCode = keyof typeof historyStorageMessages;
export function historyStorageFailure(error: unknown): HistoryStorageCode | undefined {
  const value = error as { code?: string; errcode?: number; cause?: unknown }, sqlite = typeof value?.errcode === 'number' ? value.errcode & 255 : -1;
  if (value?.code === 'ENOSPC' || value?.code === 'SQLITE_FULL' || sqlite === 13) return 'CLIENT_HISTORY_STORAGE_FULL';
  if (['EACCES', 'EPERM', 'EROFS', 'SQLITE_READONLY', 'SQLITE_PERM'].includes(value?.code || '') || [3, 8].includes(sqlite)) return 'CLIENT_HISTORY_STORAGE_DENIED';
  if (['EBUSY', 'SQLITE_BUSY', 'SQLITE_LOCKED'].includes(value?.code || '') || [5, 6].includes(sqlite)) return 'CLIENT_HISTORY_STORAGE_BUSY';
  if (['EIO', 'ENOENT', 'ENOTDIR', 'SQLITE_IOERR', 'SQLITE_CANTOPEN'].includes(value?.code || '') || [10, 14].includes(sqlite)) return 'CLIENT_HISTORY_STORAGE_IO';
  return value?.cause ? historyStorageFailure(value.cause) : undefined;
}
export interface HistoryContext { home: string; sqliteHome: string; blockingProcesses?: () => Promise<string[]> }
/** Resolve existing ancestors too, so a not-yet-created journal keeps its parent's canonical identity. */
export function historyLocation(file: string): string {
  let current = path.resolve(file); const tail: string[] = [];
  while (true) {
    try { return path.join(fs.realpathSync(current), ...tail); }
    catch (error: any) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(current) === current) throw error;
      tail.unshift(path.basename(current)); current = path.dirname(current);
    }
  }
}
export function normalizeHistoryContext(ctx: HistoryContext): HistoryContext {
  return { ...ctx, home: historyLocation(ctx.home), sqliteHome: historyLocation(ctx.sqliteHome) };
}
export function historyContext(): HistoryContext {
  const home = process.env.AURORA_CLIENT_HOME ? path.join(process.env.AURORA_CLIENT_HOME, '.codex') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return normalizeHistoryContext({ home, sqliteHome: process.env.AURORA_CLIENT_HOME ? home : process.env.CODEX_SQLITE_HOME || home });
}
export function inside(root: string, file: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(file)); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); }
export function checkedFile(root: string, file: string): string {
  // Codex stores long Windows paths even if the client home uses an 8.3 alias.
  const realRoot = fs.realpathSync.native(root), realFile = fs.realpathSync.native(file);
  if (!inside(realRoot, realFile)) throw new Error('文件路径不属于本次修复目录');
  if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw new Error('修复不接受外部链接或非普通文件');
  return realFile;
}
export function sameHistoryFile(root: string, first: string, second: string): boolean {
  try { return checkedFile(root, first) === checkedFile(root, second); } catch { return false; }
}
export async function fileHash(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function valueHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex'); }
export const repairRoot = (ctx: HistoryContext) => path.join(ctx.home, '.aurora-history-repair');
export function saveJournal(file: string, value: unknown): void { atomicWrite(file, JSON.stringify(value, null, 2) + '\n'); }
export async function assertClientsStopped(ctx: HistoryContext): Promise<void> {
  const processes = ctx.blockingProcesses ? await ctx.blockingProcesses() : await runningClients();
  if (processes.length) throw new Error(`请先完全退出 ChatGPT 桌面版 / Codex 及 CLI，再执行修复或恢复。检测到：${processes.join('、')}`);
}
export async function runningClients(): Promise<string[]> {
  const configured = await detectDesktopAsync(getDetectionContext().exePath);
  if (configured?.detectionError) throw new Error('客户端程序状态暂时无法确认，请等待更新完成或重新选择程序路径后再修复历史');
  return runningCodingClients(configured.executable ? [configured.executable] : []);
}

/** Shared across provider repair and native index repair; stale owners are recovered only after PID verification. */
export function acquireHistoryLock(ctx: HistoryContext): () => void {
  const root = repairRoot(ctx); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'repair.lock'), owner = { pid: process.pid, nonce: randomBytes(12).toString('hex'), at: new Date().toISOString() };
  const create = () => fs.writeFileSync(file, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try { create(); }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    let old: any;
    try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('修复锁无法读取，请检查是否有中断的修复任务'); }
    if (!Number.isInteger(old.pid) || old.pid <= 0) throw new Error('修复锁格式异常，请手动检查');
    let alive = true;
    try { process.kill(old.pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('已有历史修复或恢复正在执行，请等待完成');
    if (fs.readFileSync(file, 'utf8') !== JSON.stringify(old)) throw new Error('修复锁已变化，请重新操作');
    fs.unlinkSync(file); create();
  }
  return () => { try { const saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (saved.nonce === owner.nonce) fs.unlinkSync(file); } catch { /* best effort */ } };
}

export interface SqlDb { prepare(sql: string): { all(...values: any[]): any[]; get(...values: any[]): any; run(...values: any[]): { changes: number | bigint } }; close(): void; }
export function openHistoryDb(file: string, readOnly: boolean): SqlDb {
  try { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(file, { readOnly }); db.prepare('PRAGMA busy_timeout = 2000').run(); return db; }
  catch (error) { throw new Error(`无法读取历史 SQLite 数据库：${String((error as Error).message)}`, { cause: error }); }
}
export const sqlIdentifier = (value: string): string => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error('不受支持的数据库字段'); return `"${value}"`; };
export function tableColumns(db: SqlDb, table: string): Set<string> { return new Set(db.prepare(`PRAGMA table_info(${sqlIdentifier(table)})`).all().map(row => row.name)); }
export function discoverHistoryDbs(ctx: HistoryContext): string[] {
  const out: string[] = [];
  for (const dir of [ctx.sqliteHome, path.join(ctx.sqliteHome, 'sqlite')]) {
    if (!fs.existsSync(dir)) continue;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isFile() || !/\.(?:sqlite|sqlite3|db)$/i.test(item.name)) continue;
      if (dir === ctx.sqliteHome && !/^(?:state_\d+|thread_history_\d+)\.sqlite$/.test(item.name)) continue;
      const file = path.join(dir, item.name); checkedFile(ctx.sqliteHome, file); out.push(file);
    }
  }
  if (out.length > 40) throw new Error('当前目录数据库过多，请检查 CODEX_SQLITE_HOME 配置');
  return out.sort();
}

/** Read-only native provider regions for history filtering; duplicate canonical identities stay ambiguous. */
export function nativeSessionRegions(ctx: HistoryContext = historyContext()): Map<string, { modelProvider?: string; archived?: boolean }> {
  const regions = new Map<string, { modelProvider?: string; archived?: boolean }>(), seen = new Set<string>();
  for (const file of discoverHistoryDbs(ctx)) {
    const db = openHistoryDb(file, true);
    try {
      const columns = tableColumns(db, 'threads');
      if (!columns.has('id') || !columns.has('model_provider')) continue;
      const rows = db.prepare(`SELECT id,model_provider${columns.has('archived') ? ',archived' : ''} FROM threads LIMIT 50001`).all();
      if (rows.length > 50000) throw new Error('原生会话索引过大，未加载区域筛选');
      for (const row of rows) {
        if (typeof row.id !== 'string') continue;
        if (seen.has(row.id)) { regions.set(row.id, {}); continue; }
        seen.add(row.id);
        regions.set(row.id, { modelProvider: typeof row.model_provider === 'string' && row.model_provider ? row.model_provider : undefined, archived: columns.has('archived') ? !!row.archived : undefined });
      }
    } finally { db.close(); }
  }
  return regions;
}
