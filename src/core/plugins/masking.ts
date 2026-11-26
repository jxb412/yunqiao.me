import type { Block, IRRequest } from '../types.js';
import { stableHash } from '../util.js';

/**
 * 隐私遮蔽（借鉴 magpie）：把密钥、令牌、邮箱、手机号在离开本机前替换成占位符，
 * 回程再换回来。占位符稳定（同一值每次都一样），不破坏 prompt cache。
 *
 * 流式输出可以在花括号或其 URL 百分号编码的任意位置断开。
 */
const RULES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'API_KEY', re: /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xoxb-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g },
  { kind: 'PRIVATE_KEY', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'EMAIL', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'PHONE', re: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g },
  { kind: 'ID_CARD', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { kind: 'BANK_CARD', re: /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)/g },
];

export class Masker {
  private dict = new Map<string, string>();
  private reverse = new Map<string, string>();
  private pending = new Map<string, string>();

  constructor(private enabled: boolean) {}

  get active(): boolean {
    return this.enabled;
  }

  private placeholder(kind: string, value: string): string {
    const existed = this.reverse.get(value);
    if (existed) return existed;
    const ph = `{{${kind}_${stableHash(value).slice(0, 8)}}}`;
    this.reverse.set(value, ph);
    this.dict.set(ph, value);
    return ph;
  }

  maskText(text: string): string {
    if (!this.enabled || !text) return text;
    let out = text;
    for (const rule of RULES) {
      out = out.replace(rule.re, (m) => this.placeholder(rule.kind, m));
    }
    return out;
  }

  maskRequest(ir: IRRequest): IRRequest {
    if (!this.enabled) return ir;
    const walk = (blocks: Block[]): Block[] =>
      blocks.map((b) => {
        if (b.type === 'text') return { ...b, text: this.maskText(b.text) };
        if (b.type === 'tool_result') return { ...b, content: walk(b.content) };
        if (b.type === 'tool_use') {
          const s = JSON.stringify(b.input);
          const masked = this.maskText(s);
          if (masked !== s) {
            try {
              return { ...b, input: JSON.parse(masked) };
            } catch {
              return b;
            }
          }
        }
        return b;
      });
    return {
      ...ir,
      system: this.maskText(ir.system),
      messages: ir.messages.map((m) => ({ ...m, blocks: walk(m.blocks) })),
    };
  }

  private restore(text: string, json: boolean): string {
    return text.replace(/\{\{([A-Za-z0-9_]+)\}\}|%7[Bb]%7[Bb]([A-Za-z0-9_]+)%7[Dd]%7[Dd]/g, (match, literal, encoded) => {
      const value = this.dict.get(`{{${literal ?? encoded}}}`);
      if (value === undefined) return match;
      if (encoded) return encodeURIComponent(value);
      return json ? JSON.stringify(value).slice(1, -1) : value;
    });
  }

  unmaskText(text: string): string {
    if (!this.enabled || !this.dict.size || !text) return text;
    return this.restore(text, false);
  }

  unmaskValue(value: any): any {
    if (!this.enabled) return value;
    if (typeof value === 'string') return this.unmaskText(value);
    if (Array.isArray(value)) return value.map((item) => this.unmaskValue(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.unmaskValue(item)]));
    return value;
  }

  /** Restore content before protocol JSON encoding; keep each output block's partial placeholder separate. */
  unmaskDelta(text: string, channel: string, json = false): string {
    if (!this.enabled || !this.dict.size) return text;
    let buf = (this.pending.get(channel) ?? '') + text;
    const literalTail = /\{\{[A-Za-z0-9_]*\}?$|\{$/.exec(buf);
    // The encoded token may end mid-triplet, including between the two opening or closing braces.
    const tail = literalTail ?? /(?:%7[Bb](?:%7[Bb][A-Za-z0-9_]*(?:%7[Dd])?)?(?:%7?)?|%7?)$/.exec(buf);
    if (tail && tail[0].length < 100) {
      this.pending.set(channel, buf.slice(tail.index));
      buf = buf.slice(0, tail.index);
    } else this.pending.delete(channel);
    return this.restore(buf, json);
  }

  flush(channel: string): string {
    const rest = this.pending.get(channel) ?? '';
    this.pending.delete(channel);
    return this.unmaskText(rest);
  }

  get stats(): { masked: number } {
    return { masked: this.dict.size };
  }
}
