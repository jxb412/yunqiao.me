import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionSummary } from './store/types.js';
import { nativeSessionRegions } from './historyRepairIO.js';
import { sessionProjectName } from './clientPaths.js';
import { readClaudeDesktopSession, scanClaudeDesktopSessions, type ClaudeDesktopSessionRecord } from './claudeDesktopSessions.js';

/**
 * 历史会话聚合：把各客户端的本地会话日志读成统一结构。
 * 只读，不改原文件；支持搜索、导出、复制恢复命令。
 */

function home(...p: string[]): string {
  return path.join(process.env.AURORA_CLIENT_HOME || os.homedir(), ...p);
}
function clientDir(env: string, fallback: string): string { return process.env.AURORA_CLIENT_HOME ? fallback : process.env[env] || fallback; }
interface SessionRoot { dir: string; agent: string; archived?: boolean; codeBuddyProjects?: boolean }
function sessionRoots(): SessionRoot[] {
  const codeBuddy = clientDir('CODEBUDDY_CONFIG_DIR', home('.codebuddy'));
  return [
    { dir: path.join(clientDir('CLAUDE_CONFIG_DIR', home('.claude')), 'projects'), agent: 'Claude Code' },
    { dir: path.join(clientDir('CODEX_HOME', home('.codex')), 'sessions'), agent: 'Codex', archived: false },
    { dir: path.join(clientDir('CODEX_HOME', home('.codex')), 'archived_sessions'), agent: 'Codex', archived: true },
    { dir: path.join(clientDir('GEMINI_CLI_HOME', home()), '.gemini', 'tmp'), agent: 'Gemini CLI' },
    { dir: path.join(codeBuddy, 'projects'), agent: 'CodeBuddy', codeBuddyProjects: true },
    { dir: path.join(codeBuddy, 'sessions'), agent: 'CodeBuddy' },
  ];
}
// CodeBuddy's project directory only stores transcripts one level down. Deeper files
// are sidecars (for example tool-results), which must not be read as conversations.
function codeBuddyFile(root: SessionRoot, file: string, resolved: string): boolean {
  const relative = path.relative(root.dir, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  if (root.codeBuddyProjects && (!file.endsWith('.jsonl') || relative.split(path.sep).length !== 2)) return false;
  const config = fs.realpathSync(path.dirname(root.dir));
  const expected = path.join(config, path.basename(root.dir), relative);
  return path.relative(expected, resolved) === '' && fs.statSync(resolved).isFile();
}
function checkSessionPath(file: string): SessionRoot {
  if (typeof file !== 'string' || !/\.jsonl?$/.test(file)) throw new Error('会话路径无效');
  let resolved: string;
  try { resolved = fs.realpathSync(file); } catch { throw new Error('会话文件不存在'); }
  const allowed = sessionRoots().find(root => {
    try {
      if (root.agent === 'CodeBuddy') return codeBuddyFile(root, file, resolved);
      const rel = path.relative(fs.realpathSync(root.dir), resolved); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    }
    catch { return false; }
  });
  if (!allowed) throw new Error('只能读取已支持客户端目录下的会话文件');
  return allowed;
}

function claudeSource(root: string, file: string): Pick<SessionSummary, 'sourceLabel' | 'sourceScope' | 'sourceKind' | 'canResume'> {
  const config = path.dirname(root);
  const standard = path.resolve(config) === path.resolve(home('.claude'));
  return { sourceLabel: standard ? '.claude · 默认目录' : `${path.basename(config)} · 自定义目录`,
    sourceScope: path.join(path.resolve(root), path.relative(root, file).split(path.sep)[0]), sourceKind: 'cli', canResume: standard };
}

function claudeTranscripts(ids: string[]): SessionSummary[] {
  const root = sessionRoots().find(item => item.agent === 'Claude Code')!;
  const expected = new Set(ids);
  return walk(root.dir, name => name.endsWith('.jsonl') && expected.has(path.basename(name, '.jsonl'))).flatMap(file => {
    const item = summarize(file, root.agent, root.dir);
    return item ? [{ ...item, ...claudeSource(root.dir, file) }] : [];
  });
}

function desktopLinks(records: ClaudeDesktopSessionRecord[], transcripts: SessionSummary[]) {
  const claims = new Map<string, number>(), byId = new Map<string, SessionSummary[]>();
  for (const item of records) for (const id of item.cliIds) claims.set(id, (claims.get(id) || 0) + 1);
  for (const item of transcripts) if (!item.isSubagent) byId.set(item.id, [...(byId.get(item.id) || []), item]);
  return { claims, byId };
}

function projectIdentity(value: string): string {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(value)
    ? path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
    : path.posix.normalize(value).replace(/\/+$/, '');
}

function defaultClaudeTranscript(file: string): boolean {
  const userHome = path.resolve(home()), root = path.join(userHome, '.claude', 'projects');
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return false;
  try {
    let expected = fs.realpathSync(userHome), actual = userHome;
    const same = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
    for (const part of path.relative(userHome, file).split(path.sep)) {
      actual = path.join(actual, part); expected = path.join(expected, part);
      const stat = fs.lstatSync(actual);
      if (stat.isSymbolicLink() || !same(fs.realpathSync(actual), expected)) return false;
    }
    return fs.statSync(file).isFile();
  } catch { return false; }
}

/** Match explicit transcript IDs and project directories. Never infer a supplier or merge profiles. */
function desktopTranscript(record: ClaudeDesktopSessionRecord, links: ReturnType<typeof desktopLinks>): {
  transcript?: SessionSummary; status: 'available' | 'metadata-only' | 'ambiguous'; note: string;
} {
  if (!record.cwd || !record.cliIds.length) return { status: 'metadata-only', note: '仅有会话记录，正文未定位；请在原 Claude 桌面客户端中打开。' };
  // Desktop does not declare CLAUDE_CONFIG_DIR. A custom CLI root is not evidence of its ownership.
  const defaultScope = path.resolve(home('.claude', 'projects'));
  for (let index = 0; index < record.cliIds.length; index++) {
    const id = record.cliIds[index];
    const candidates = (links.byId.get(id) || []).filter(item => path.dirname(item.sourceScope || '') === defaultScope
      && path.basename(item.path, '.jsonl') === id && item.cwd && projectIdentity(item.cwd) === projectIdentity(record.cwd)
      && defaultClaudeTranscript(item.path));
    if (!candidates.length) continue;
    if (candidates.length > 1 || (links.claims.get(id) || 0) > 1) {
      return { status: 'ambiguous', note: '正文关联不唯一，可能属于不同账号或目录；请在原 Claude 桌面客户端中核对，未自动合并。' };
    }
    return { transcript: candidates[0], status: 'available', note: id !== record.cliSessionId
      ? '当前正文未定位，仅显示记录中关联的历史片段；完整对话请在原 Claude 桌面客户端中查看。'
      : '已按会话 ID 和项目目录匹配本地正文。来源角标表示存储目录，不代表模型供应商；CLI 原记录仍保留。' };
  }
  return { status: 'metadata-only', note: '仅有会话记录，正文未定位；请在原 Claude 桌面客户端中打开。' };
}

function desktopSummary(record: ClaudeDesktopSessionRecord, links: ReturnType<typeof desktopLinks>): SessionSummary {
  const linked = desktopTranscript(record, links), transcript = linked.transcript;
  return { id: record.id, agent: 'Claude Desktop', title: record.title || record.id, cwd: record.cwd || undefined,
    project: record.cwd ? sessionProjectName(record.cwd) : undefined, path: record.path,
    messageCount: transcript?.messageCount || 0, tokens: 0, cost: 0, model: transcript?.model,
    archived: record.isArchived, updatedAt: new Date(record.updatedAtMs).toISOString(),
    createdAt: new Date(record.createdAtMs ?? record.modifiedAtMs).toISOString(), sizeBytes: record.size,
    sourceLabel: record.sourceLabel, sourceScope: record.sourceScope, sourceKind: 'desktop',
    contentStatus: linked.status, contentNote: linked.note, canResume: false, truncated: transcript?.truncated };
}

/** Read a bounded byte window from a potentially large transcript. */
function readChunk(file: string, bytes: number, offset = 0): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, offset);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function walk(dir: string, filter: (f: string) => boolean, remainingDepth = 8, out: string[] = []): string[] {
  if (out.length >= 5000) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (out.length >= 5000) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (remainingDepth <= 0 || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(full, filter, remainingDepth - 1, out);
    } else if (e.isFile() && filter(e.name)) {
      out.push(full);
    }
  }
  return out;
}

interface TranscriptLine { role: 'user' | 'assistant' | 'tool' | ''; text: string; model?: string; cwd?: string; toolName?: string }

function* sessionRecords(lines: string[]): Generator<any> {
  for (const line of lines) {
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if (record && typeof record === 'object' && !Array.isArray(record)) yield record;
  }
}

function codeBuddyLine(o: any): TranscriptLine {
  const cwd = typeof o.cwd === 'string' ? o.cwd : undefined;
  const model = typeof o.providerData?.model === 'string' ? o.providerData.model : undefined;
  if (o.type === 'message' && ['user', 'assistant'].includes(o.role) && !(o.role === 'user' && o.providerData?.isMeta === true)) {
    return { ...extractLine({ role: o.role, content: o.content }), cwd, model };
  }
  if (o.type === 'function_call' && typeof o.name === 'string') {
    const args = typeof o.arguments === 'string' ? o.arguments : JSON.stringify(o.arguments ?? {});
    return { role: 'assistant', text: `调用工具：${o.name}\n${args}`, toolName: o.name, cwd, model };
  }
  if (o.type === 'function_call_result') {
    const output = typeof o.output === 'string' ? o.output : o.output?.text ?? JSON.stringify(o.output ?? null);
    return { role: 'tool', text: `工具结果：\n${output}`, toolName: typeof o.name === 'string' ? o.name : undefined, cwd, model };
  }
  if (o.type === 'reasoning') {
    for (const content of [o.rawContent, o.content]) {
      const text = Array.isArray(content) ? content.map(block => block?.text).filter(value => typeof value === 'string').join('\n') : '';
      if (text.trim()) return { role: 'assistant', text: `[思考]\n${text}`, cwd, model };
    }
  }
  return { role: '', text: '', cwd };
}

function extractLine(o: any): TranscriptLine {
  // Codex：{type:'response_item', payload:{type:'message', role, content:[{type:'input_text',text}]}}
  const payload = o?.payload ?? {};
  let role: any = o?.message?.role ?? o?.role ?? '';
  let content = o?.message?.content ?? o?.content ?? payload?.content;
  if (!role && payload?.type === 'message') role = payload.role;
  if (!role && o?.type === 'event_msg' && payload?.type === 'user_message') {
    role = 'user';
    content = payload.message;
  }
  if (!role && o?.type === 'user') role = 'user';
  if (!role && o?.type === 'assistant') role = 'assistant';
  if (!role && o?.type === 'gemini') role = 'assistant';
  if (!role && payload?.type === 'function_call') { role = 'assistant'; content = [{ type: 'function_call', name: payload.name, arguments: payload.arguments }]; }
  if (!role && payload?.type === 'function_call_output') { role = 'tool'; content = [{ type: 'function_call_output', output: payload.output }]; }
  const model = o?.message?.model ?? payload?.model ?? o?.model;
  const cwd = o?.cwd ?? payload?.cwd;

  let text = '';
  let toolName = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (!b) continue;
      if (typeof b === 'string') parts.push(b);
      else if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text' || (!b.type && typeof b.text === 'string')) parts.push(b.text ?? '');
      else if (b.type === 'tool_use') {
        toolName = b.name ?? '';
        parts.push(`\n调用工具：${b.name}\n${JSON.stringify(b.input ?? {}, null, 2)}`);
      } else if (b.type === 'tool_result')
        parts.push(`\n工具结果：\n${typeof b.content === 'string' ? b.content : JSON.stringify(b.content).slice(0, 2000)}`);
      else if (b.type === 'thinking') parts.push(`\n[思考]\n${b.thinking ?? ''}`);
      else if (b.type === 'image') parts.push('[图片]');
      else if (b.type === 'function_call') {
        toolName = b.name ?? '';
        parts.push(`\n调用工具：${b.name}\n${b.arguments ?? ''}`);
      } else if (b.type === 'function_call_output') parts.push(`\n工具结果：\n${b.output ?? ''}`);
    }
    text = parts.join('');
  }
  const r = String(role).toLowerCase();
  const norm: 'user' | 'assistant' | 'tool' | '' =
    r === 'user' || r === 'human'
      ? 'user'
      : r === 'assistant' || r === 'ai'
        ? 'assistant'
        : r === 'tool' || r === 'function'
          ? 'tool'
          : '';
  return { role: norm, text, model, cwd, toolName };
}

const sessionIdentifier = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$/.test(value) ? value : undefined;

type SessionRelation = Pick<SessionSummary, 'isSubagent' | 'parentSessionId' | 'subagentId'>;

function codexRelation(metadata: any): SessionRelation {
  const source = metadata.source;
  const subagent = source && typeof source === 'object' && !Array.isArray(source) ? source.subagent : undefined;
  const spawn = subagent && typeof subagent === 'object' && !Array.isArray(subagent) ? subagent.thread_spawn : undefined;
  const serializedSpawn = typeof source === 'string' ? /^subagent_thread_spawn_([0-9a-f-]{36})_d\d+$/i.exec(source) : null;
  const parent = sessionIdentifier(metadata.parent_thread_id) || sessionIdentifier(spawn?.parent_thread_id) || sessionIdentifier(subagent?.parent_thread_id) || sessionIdentifier(serializedSpawn?.[1]);
  const parentSessionId = parent !== metadata.id ? parent : undefined;
  // Match native discriminators only: names, prompts and fork ancestry are not evidence of a subagent.
  const isSubagent = !!parentSessionId || metadata.thread_source === 'subagent' ||
    typeof subagent === 'string' || !!subagent && typeof subagent === 'object' && !Array.isArray(subagent) ||
    ['subagent', 'subagent_review', 'subagent_compact', 'subagent_memory_consolidation'].includes(source) || !!serializedSpawn;
  return isSubagent ? { isSubagent: true, ...(parentSessionId ? { parentSessionId } : {}) } : {};
}

function claudePathRelation(file: string, root: string): SessionRelation {
  const relative = path.relative(root, file).split(path.sep);
  // Native layout: <project>/<session UUID>/subagents/[workflows/...]/agent-<id>.jsonl.
  // A file merely named agent-*.jsonl outside this layout remains an ordinary session.
  if (relative.length < 4 || relative[2] !== 'subagents' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(relative[1])) return {};
  const match = /^agent-([A-Za-z0-9][A-Za-z0-9_-]{0,200})\.jsonl$/.exec(relative.at(-1) || '');
  return match ? { isSubagent: true, parentSessionId: relative[1], subagentId: match[1] } : {};
}

function codeBuddyResume(id: string, cwd: unknown, platform: NodeJS.Platform): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,200}$/.test(id) || typeof cwd !== 'string' || /[\u0000-\u001f\u007f]/.test(cwd)) return '';
  const command = `codebuddy --resume ${id}`;
  if (platform === 'win32') {
    if (!/^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(cwd)) return '';
    // PowerShell also treats typographic single quotes as delimiters. Doubling the
    // actual delimiter retains that exact character inside a single-quoted literal.
    const literal = cwd.replace(/['\u2018-\u201b]/g, char => char + char);
    return `& { Push-Location -LiteralPath '${literal}' -ErrorAction Stop; try { ${command} } finally { Pop-Location } }`;
  }
  return path.posix.isAbsolute(cwd) ? `(cd '${cwd.replace(/'/g, `'"'"'`)}' && ${command})` : '';
}
function codeBuddySummary(file: string, root: string, stat: fs.Stats): SessionSummary | null {
  const id = path.basename(file, '.jsonl');
  const maxBytes = 256 * 1024;
  const lines = readChunk(file, Math.min(stat.size, maxBytes)).split('\n').filter(Boolean);
  const truncated = stat.size > maxBytes || lines.length > 600;
  const nativeTitle = (record: any) => record.type === 'ai-title' && typeof record.aiTitle === 'string' ? record.aiTitle.trim().slice(0, 80) : '';
  let title = '', firstPrompt = '', firstReply = '', messageCount = 0;
  let cwd: string | undefined, model: string | undefined;
  let sawId = false, idMismatch = false;
  for (const record of sessionRecords(lines.slice(0, 600))) {
    if (typeof record.sessionId === 'string') {
      sawId = true;
      if (record.sessionId !== id) idMismatch = true;
    }
    title = nativeTitle(record) || title;
    const line = codeBuddyLine(record);
    cwd ||= line.cwd;
    model ||= line.model;
    if (!line.role || !line.text.trim()) continue;
    messageCount++;
    if (record.type === 'message' && line.role === 'user') firstPrompt ||= line.text.trim().slice(0, 80);
    if (record.type === 'message' && line.role === 'assistant') firstReply ||= line.text.trim().slice(0, 80);
  }
  if (!messageCount && !truncated) return null;
  if (truncated) {
    // The native client appends title changes, often after our bounded summary window.
    const bytes = Math.min(stat.size, 64 * 1024);
    const tail = readChunk(file, bytes, stat.size - bytes).split('\n');
    if (bytes < stat.size) tail.shift();
    for (const record of sessionRecords(tail.reverse())) {
      const latestTitle = nativeTitle(record);
      if (latestTitle) { title = latestTitle; break; }
    }
  }
  return {
    id, agent: 'CodeBuddy', title: title || firstPrompt || firstReply || id, cwd, model, path: file,
    project: cwd ? sessionProjectName(cwd) : undefined, messageCount, tokens: 0, cost: 0,
    updatedAt: stat.mtime.toISOString(), createdAt: stat.birthtime.toISOString(), sizeBytes: stat.size, truncated,
    canResume: sawId && !idMismatch && !!codeBuddyResume(id, cwd, process.platform) && path.relative(path.dirname(root), home('.codebuddy')) === '',
  };
}

function summarize(file: string, agent: string, root: string, codeBuddyProjects = false): SessionSummary | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (codeBuddyProjects) return codeBuddySummary(file, root, stat);
  } catch {
    return null;
  }
  let title = '';
  let messageCount = 0;
  let model = '';
  let modelProvider: string | undefined;
  let cwd = '';
  let id = path.basename(file).replace(/\.jsonl?$/, '');
  let truncated = false;
  let relation: SessionRelation = agent === 'Claude Code' ? claudePathRelation(file, root) : {};
  let firstRecord = true;
  try {
    // 只读文件头：Codex 的长会话可能有几百 MB，整个读进来会把主进程打死
    const isJson = file.endsWith('.json');
    const head = readChunk(file, isJson ? 8 * 1024 * 1024 : 256 * 1024);
    const document = isJson ? JSON.parse(head) : null;
    const lines = isJson ? (document.messages || []).map((x: any) => JSON.stringify(x)) : head.split('\n').filter(Boolean).slice(0, 600);
    if (document?.sessionId) id = document.sessionId;
    truncated = stat.size > Buffer.byteLength(head) || (!isJson && head.split('\n').length > 600);
    for (const o of sessionRecords(lines)) {
      if (o.type === 'session_meta' && typeof o.payload?.id === 'string') {
        id = o.payload.id;
        if (typeof o.payload.model_provider === 'string') modelProvider = o.payload.model_provider;
        if (agent === 'Codex') relation = codexRelation(o.payload);
      }
      if (typeof o.sessionId === 'string') id = o.sessionId;
      // Claude marks a sidechain on the transcript's first record. Later sidechain entries
      // inside a main transcript must not hide that main conversation.
      if (agent === 'Claude Code' && firstRecord && o.isSidechain === true) {
        relation = { isSubagent: true, parentSessionId: sessionIdentifier(o.sessionId), subagentId: sessionIdentifier(o.agentId), ...relation };
      }
      firstRecord = false;
      const ex = extractLine(o);
      cwd = cwd || ex.cwd || '';
      model = model || ex.model || '';
      if (!ex.role) continue;
      messageCount++;
      if (!title && ex.role === 'user' && ex.text.trim()) {
        const cleaned = ex.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        // Codex 会把 AGENTS.md 注入到第一条 user 消息前面，跳过它找真正的提问
        if (cleaned && !/^#/.test(cleaned) && !/AGENTS\.md instructions/i.test(cleaned) && cleaned.length > 2) {
          title = cleaned.slice(0, 80);
        }
      }
    }
  } catch {
    return null;
  }
  if (!title) title = path.basename(file, '.jsonl');
  return {
    id,
    agent,
    ...(agent === 'CodeBuddy' ? { canResume: false } : {}),
    ...relation,
    title,
    project: cwd ? sessionProjectName(cwd) : undefined,
    cwd: cwd || undefined,
    path: file,
    messageCount,
    tokens: 0,
    cost: 0,
    model: model || undefined,
    modelProvider,
    updatedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime?.toISOString?.() ?? stat.mtime.toISOString(),
    sizeBytes: stat.size,
    truncated,
  };
}

export function scanSessions(): SessionSummary[] {
  const out: SessionSummary[] = [];
  const codeBuddyById = new Map<string, SessionSummary>();
  let regions: ReturnType<typeof nativeSessionRegions> = new Map();
  try { regions = nativeSessionRegions(); } catch { /* Log-only histories still remain readable when the native index is unavailable. */ }
  for (const root of sessionRoots()) {
    const files = walk(root.dir, n => n.endsWith('.jsonl') || (root.agent === 'Gemini CLI' && /^session.*\.json$/.test(n)), root.codeBuddyProjects ? 1 : 8);
    for (const f of files) {
      if (root.agent === 'CodeBuddy') {
        try { if (!codeBuddyFile(root, f, fs.realpathSync(f))) continue; } catch { continue; }
      }
      const s = summarize(f, root.agent, root.dir, root.codeBuddyProjects);
      if (s) {
        if (root.codeBuddyProjects) {
          const previous = codeBuddyById.get(s.id);
          if (previous) { previous.canResume = false; s.canResume = false; }
          else codeBuddyById.set(s.id, s);
        }
        if (root.agent === 'Claude Code') Object.assign(s, claudeSource(root.dir, f));
        if (root.agent === 'Codex') {
          const region = regions.get(s.id);
          if (regions.has(s.id)) s.modelProvider = region?.modelProvider;
          s.archived = region?.archived ?? root.archived;
        }
        out.push(s);
      }
    }
  }

  const desktops = scanClaudeDesktopSessions();
  const transcripts = out.filter(item => item.agent === 'Claude Code');
  const links = desktopLinks(desktops, transcripts);
  out.push(...desktops.map(record => desktopSummary(record, links)));

  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  model?: string;
  ts?: string;
  toolName?: string;
}

export function readSession(file: string, limit = 400): SessionMessage[] {
  if (typeof file === 'string' && /^local_.+\.json$/.test(path.basename(file))) {
    const record = readClaudeDesktopSession(file);
    const linked = desktopTranscript(record, desktopLinks(scanClaudeDesktopSessions(), claudeTranscripts(record.cliIds)));
    return linked.transcript ? readSession(linked.transcript.path, limit) : [];
  }
  const root = checkSessionPath(file);
  limit = Math.max(1, Math.min(2000, Number(limit) || 400));
  const out: SessionMessage[] = [];
  let txt = '';
  try {
    txt = readChunk(file, file.endsWith('.json') ? 8 * 1024 * 1024 : 4 * 1024 * 1024);
  } catch {
    return out;
  }
  let lines = txt.split('\n');
  if (file.endsWith('.json')) {
    try { lines = (JSON.parse(txt).messages || []).map((x: any) => JSON.stringify(x)); }
    catch { throw new Error('此 JSON 会话文件不完整或超过 8 MB，请在原客户端中打开'); }
  }
  for (const o of sessionRecords(lines)) {
    const ex = root.codeBuddyProjects ? codeBuddyLine(o) : extractLine(o);
    let ts = o.timestamp ?? o.ts ?? o.created_at ?? o?.payload?.timestamp;
    if (root.codeBuddyProjects && typeof ts === 'number') {
      const time = new Date(ts);
      ts = Number.isFinite(time.getTime()) ? time.toISOString() : undefined;
    }
    if (!ex.role || !ex.text.trim()) continue;
    out.push({ role: ex.role, text: ex.text, ts, model: ex.model, toolName: ex.toolName });
    if (out.length >= limit) break;
  }
  return out;
}

export function resumeCommand(s: SessionSummary, platform: NodeJS.Platform = process.platform): string {
  if (s?.isSubagent || s?.canResume === false || s?.sourceKind === 'desktop') return '';
  if (!s || typeof s.id !== 'string') return '';
  if (s.agent === 'CodeBuddy') return s.canResume === true ? codeBuddyResume(s.id, s.cwd, platform) : '';
  if (!sessionIdentifier(s.id)) return '';
  if (s.agent === 'Claude Code') return `claude --resume ${s.id}`;
  if (s.agent === 'Codex') {
    if (s.modelProvider === undefined) return `codex resume ${s.id}`;
    const provider = s.modelProvider;
    if (typeof provider !== 'string' || !provider || provider.length > 200 || provider.trim() !== provider
      || /[\u0000-\u001f\u007f]/.test(provider) || Buffer.from(provider, 'utf8').toString('utf8') !== provider) return '';
    // PowerShell 5 drops embedded double quotes when invoking native programs.
    // TOML literal strings keep the exact provider through both PS5 and PS7.
    // Refuse values without a portable literal instead of resuming elsewhere;
    // PowerShell also treats typographic quotes as shell delimiters.
    if (platform === 'win32' && /"|'''|[\u2018-\u201f]/.test(provider)) return '';
    const value = platform === 'win32' ? provider.includes("'") ? `'''${provider}'''` : `'${provider}'` : JSON.stringify(provider);
    const override = `model_provider=${value}`;
    const argument = platform === 'win32' ? `'${override.replace(/'/g, "''")}'` : `'${override.replace(/'/g, `'"'"'`)}'`;
    return `codex -c ${argument} resume ${s.id}`;
  }
  if (s.agent === 'Gemini CLI') return `gemini --resume ${s.id}`;
  return '';
}

export function exportSessionMarkdown(s: SessionSummary): string {
  const msgs = readSession(s.path, 2000);
  const head = [
    `# ${s.title}`,
    '',
    `- 客户端：${s.agent}`,
    `- 模型：${s.model ?? '未知'}`,
    ...(s.sourceLabel ? [`- 来源：${s.sourceLabel}`] : []),
    ...(s.contentNote ? [`- 正文说明：${s.contentNote}`] : []),
    `- 目录：${s.cwd ?? '—'}`,
    `- 更新时间：${new Date(s.updatedAt).toLocaleString('zh-CN')}`,
    `- 已索引消息数：${s.messageCount}${s.truncated ? '（部分）' : ''}`,
    ...(s.truncated || s.sizeBytes > (s.path.endsWith('.json') ? 8 : 4) * 1024 * 1024 || msgs.length >= 2000 ? ['- 导出范围：仅包含读取上限内的消息，完整会话请在原客户端打开。'] : []),
    '',
    '---',
    '',
  ].join('\n');
  const body = msgs
    .map((m) => `## ${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '工具'}\n\n${m.text}\n`)
    .join('\n');
  return head + body;
}
