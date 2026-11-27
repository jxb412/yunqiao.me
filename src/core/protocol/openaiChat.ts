/**
 * OpenAI Chat Completions 协议（DeepSeek / Kimi / GLM / 中转站 / 本地 ollama 都说这个）
 *
 * 已知坑位：
 *  - assistant 的 tool_calls 必须与内容同一条消息，tool 结果必须紧跟其后（Codex++ #327）
 *  - 部分上游只认 role:system 单条，不接受 system 数组
 *  - reasoning_content / reasoning 两种字段名都要吃
 */
import type { Block, IRRequest, IRResponse, Message, StreamEvent, ToolChoice } from '../types.js';
import { blocksToText, msgId, openaiToolCallId, stableHash } from '../util.js';

/* ============================ 入站解析 ============================ */

export function parseOpenAIChatRequest(body: any): IRRequest {
  const raw = body ?? {};
  const messages: Message[] = [];
  let system = '';
  if (typeof raw.instructions === 'string') system = raw.instructions;

  for (const m of raw.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') {
      system += (system ? '\n\n' : '') + contentToText(m.content);
      continue;
    }
    if (m.role === 'tool') {
      const text = contentToText(m.content);
      messages.push({
        role: 'user',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: m.tool_call_id,
            content: [{ type: 'text', text }],
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Block[] = [];
      const reasoning = m.reasoning_content ?? m.reasoning;
      if (typeof reasoning === 'string' && reasoning) blocks.push({ type: 'thinking', text: reasoning });
      const text = contentToText(m.content);
      if (text) blocks.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments ?? {};
        } catch {
          input = { _raw: tc.function?.arguments };
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id ?? openaiToolCallId(),
          name: tc.function?.name ?? 'unknown',
          input,
        });
      }
      if (blocks.length) messages.push({ role: 'assistant', blocks });
      continue;
    }
    // user / 其他
    messages.push({ role: 'user', blocks: contentToBlocks(m.content) });
  }

  const tools = (raw.tools ?? []).map((t: any) => ({
    name: t.function?.name,
    description: t.function?.description,
    parameters: t.function?.parameters ?? { type: 'object', properties: {} },
  }));

  let toolChoice: ToolChoice = { type: 'auto' };
  const tc = raw.tool_choice;
  if (tc === 'none') toolChoice = { type: 'none' };
  else if (tc === 'required') toolChoice = { type: 'any' };
  else if (tc?.function?.name) toolChoice = { type: 'tool', name: tc.function.name };

  return {
    model: raw.model,
    system,
    messages,
    tools,
    toolChoice,
    maxTokens: raw.max_completion_tokens ?? raw.max_tokens,
    temperature: raw.temperature,
    topP: raw.top_p,
    stop: typeof raw.stop === 'string' ? [raw.stop] : raw.stop,
    stream: !!raw.stream,
    reasoning:
      raw.reasoning_effort ??
      (raw.reasoning?.effort as any) ??
      (raw.enable_thinking ? 'medium' : undefined),
    raw,
    sessionKey: raw.user ?? raw.metadata?.user_id ?? hashFirst(messages),
  };
}

function hashFirst(messages: Message[]): string | undefined {
  const first = messages[0];
  return first ? stableHash(blocksToText(first.blocks).slice(0, 400)) : undefined;
}

function contentToText(content: any): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((p: any) => (typeof p === 'string' ? p : p?.text ?? (p?.type === 'image_url' ? '[image]' : '')))
      .join('');
  return JSON.stringify(content);
}

function contentToBlocks(content: any): Block[] {
  if (content == null) return [];
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [{ type: 'text', text: JSON.stringify(content) }];
  const out: Block[] = [];
  for (const p of content) {
    if (typeof p === 'string') {
      out.push({ type: 'text', text: p });
      continue;
    }
    if (p.type === 'text') out.push({ type: 'text', text: p.text ?? '' });
    else if (p.type === 'image_url') {
      const url: string = p.image_url?.url ?? '';
      if (url.startsWith('data:')) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (m) out.push({ type: 'image', mediaType: m[1], data: m[2], source: 'base64' });
      } else if (url) out.push({ type: 'image', mediaType: 'image/*', data: url, source: 'url' });
    } else if (p.type === 'input_text') out.push({ type: 'text', text: p.text ?? '' });
    else if (p.type === 'input_image' && p.image_url) {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url;
      if (url?.startsWith('data:')) {
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (m) out.push({ type: 'image', mediaType: m[1], data: m[2], source: 'base64' });
      }
    }
  }
  return out;
}

/* ============================ 出站编码 ============================ */

export interface ChatEncodeOptions {
  model: string;
  maxTokens?: number;
  /** 部分上游（DeepSeek R1 系）需要显式打开思考 */
  thinkingField?: 'reasoning_effort' | 'enable_thinking' | 'none';
  /** 不支持图片时把图片替换成文字提示 */
  dropImages?: boolean;
}

export function encodeOpenAIChatRequest(ir: IRRequest, opt: ChatEncodeOptions): any {
  const messages: any[] = [];
  const translatedCallIds = new Map<string, string>();
  if (ir.system) messages.push({ role: 'system', content: ir.system });

  for (const m of ir.messages) {
    if (m.role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      let reasoning: string | undefined;
      for (const b of m.blocks) {
        if (b.type === 'text') textParts.push(b.text);
        else if (b.type === 'thinking') reasoning = (reasoning ? reasoning + '\n' : '') + b.text;
        else if (b.type === 'tool_use') {
          const id = b.id?.startsWith('call_') ? b.id : openaiToolCallId();
          if (b.id && id !== b.id) translatedCallIds.set(b.id, id);
          toolCalls.push({
            id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      const msg: any = { role: 'assistant', content: textParts.join('') || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (reasoning) msg.reasoning_content = reasoning;
      messages.push(msg);
      continue;
    }
    // user：先拆 tool 结果，再放普通内容
    const toolMsgs: any[] = [];
    const parts: any[] = [];
    for (const b of m.blocks) {
      if (b.type === 'tool_result') {
        toolMsgs.push({
          role: 'tool',
          tool_call_id: translatedCallIds.get(b.toolUseId) ?? b.toolUseId,
          content: blocksToText(b.content) || '(no output)',
        });
        translatedCallIds.delete(b.toolUseId);
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        if (opt.dropImages) parts.push({ type: 'text', text: '[图片已省略：该供应商不支持图像输入]' });
        else
          parts.push({
            type: 'image_url',
            image_url: {
              url: b.source === 'url' ? b.data : `data:${b.mediaType};base64,${b.data}`,
            },
          });
      }
    }
    messages.push(...toolMsgs);
    if (parts.length)
      messages.push({
        role: 'user',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      });
  }

  const body: any = { model: opt.model, messages };
  if (ir.tools.length)
    body.tools = ir.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));
  if (ir.tools.length) {
    if (ir.toolChoice.type === 'any') body.tool_choice = 'required';
    else if (ir.toolChoice.type === 'none') body.tool_choice = 'none';
    else if (ir.toolChoice.type === 'tool')
      body.tool_choice = { type: 'function', function: { name: ir.toolChoice.name } };
  }
  if (typeof ir.temperature === 'number') body.temperature = ir.temperature;
  if (typeof ir.topP === 'number') body.top_p = ir.topP;
  if (ir.stop?.length) body.stop = ir.stop;
  const max = opt.maxTokens ?? ir.maxTokens;
  if (max) body.max_tokens = max;
  if (ir.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (ir.reasoning && ir.reasoning !== 'off') {
    if (opt.thinkingField === 'enable_thinking') body.enable_thinking = true;
    else if (opt.thinkingField !== 'none') body.reasoning_effort = ir.reasoning;
  }
  return body;
}

/* ============================ 响应解码 ============================ */

export function parseOpenAIChatResponse(json: any): IRResponse {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const blocks: Block[] = [];
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  if (reasoning) blocks.push({ type: 'thinking', text: reasoning });
  if (msg.content) blocks.push({ type: 'text', text: contentToText(msg.content) });
  for (const tc of msg.tool_calls ?? [])
    blocks.push({
      type: 'tool_use',
      id: tc.id ?? openaiToolCallId(),
      name: tc.function?.name ?? 'unknown',
      input: safeParse(tc.function?.arguments),
    });
  return {
    id: json?.id ?? msgId(),
    model: json?.model ?? '',
    blocks,
    stopReason: mapFinish(choice.finish_reason, blocks),
    usage: {
      inputTokens: json?.usage?.prompt_tokens ?? 0,
      outputTokens: json?.usage?.completion_tokens ?? 0,
      cacheReadTokens: json?.usage?.prompt_tokens_details?.cached_tokens ?? json?.usage?.prompt_cache_hit_tokens,
      cacheWriteTokens: json?.usage?.cache_creation_input_tokens,
      reasoningTokens: json?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

function safeParse(s: any): unknown {
  if (typeof s !== 'string') return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

function mapFinish(f: string | undefined, blocks: Block[]): IRResponse['stopReason'] {
  if (f === 'length') return 'max_tokens';
  if (f === 'tool_calls' || blocks.some((b) => b.type === 'tool_use')) return 'tool_use';
  return 'end_turn';
}

/* ============================ 流式解码 ============================ */

const THINK_IDX = 0;
const TEXT_IDX = 1;
const TOOL_BASE = 2;

export class OpenAIChatStreamDecoder {
  private toolIndex = new Map<number, number>();

  push(_event: string | undefined, data: string): StreamEvent[] {
    if (!data || data === '[DONE]') return [];
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      return [];
    }
    const out: StreamEvent[] = [];
    if (j.error) return [{ type: 'error', message: j.error.message ?? '上游返回流式错误' }];
    if (!this.started) {
      this.started = true;
      out.push({ type: 'start', id: j.id ?? msgId(), model: j.model ?? '' });
    }
    const choice = j.choices?.[0];
    const delta = choice?.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string' && reasoning)
      out.push({ type: 'thinking_delta', index: THINK_IDX, text: reasoning });
    if (typeof delta.content === 'string' && delta.content)
      out.push({ type: 'text_delta', index: TEXT_IDX, text: delta.content });

    for (const tc of delta.tool_calls ?? []) {
      const up = tc.index ?? 0;
      if (!this.toolIndex.has(up)) {
        this.toolIndex.set(up, TOOL_BASE + up);
        out.push({
          type: 'tool_start',
          index: TOOL_BASE + up,
          id: tc.id ?? openaiToolCallId(),
          name: tc.function?.name ?? 'tool',
        });
      }
      const irIdx = this.toolIndex.get(up)!;
      if (tc.function?.arguments)
        out.push({ type: 'tool_delta', index: irIdx, json: tc.function.arguments });
    }

    if (j.usage)
      out.push({
        type: 'usage',
        usage: {
          inputTokens: j.usage.prompt_tokens ?? 0,
          outputTokens: j.usage.completion_tokens ?? 0,
          cacheReadTokens: j.usage.prompt_tokens_details?.cached_tokens ?? j.usage.prompt_cache_hit_tokens,
          cacheWriteTokens: j.usage.cache_creation_input_tokens,
        },
      });
    if (choice?.finish_reason)
      out.push({
        type: 'stop',
        stopReason:
          choice.finish_reason === 'length'
            ? 'max_tokens'
            : choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : 'end_turn',
      });
    return out;
  }

  private started = false;
}

/* ============================ 流式编码 ============================ */

export class OpenAIChatStreamEncoder {
  private created = Math.floor(Date.now() / 1000);
  private toolIdx = new Map<number, number>();
  private nextTool = 0;
  private finish: string | null = null;
  private usage: any = null;
  private sentRole = false;

  constructor(private ctx: { requestId: string; model: string; clientModel: string }) {}

  private chunk(delta: any, finish: string | null = null): string {
    const payload = {
      id: this.ctx.requestId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.ctx.clientModel || this.ctx.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  push(e: StreamEvent): string {
    switch (e.type) {
      case 'text_delta': {
        let out = '';
        if (!this.sentRole) {
          this.sentRole = true;
          out += this.chunk({ role: 'assistant', content: '' });
        }
        return out + this.chunk({ content: e.text });
      }
      case 'thinking_delta': {
        let out = '';
        if (!this.sentRole) {
          this.sentRole = true;
          out += this.chunk({ role: 'assistant', content: '' });
        }
        return out + this.chunk({ reasoning_content: e.text });
      }
      case 'tool_start': {
        let out = '';
        if (!this.sentRole) {
          this.sentRole = true;
          out += this.chunk({ role: 'assistant', content: '' });
        }
        const idx = this.nextTool++;
        this.toolIdx.set(e.index, idx);
        return (
          out +
          this.chunk({
            tool_calls: [{ index: idx, id: e.id, type: 'function', function: { name: e.name, arguments: '' } }],
          })
        );
      }
      case 'tool_delta': {
        const idx = this.toolIdx.get(e.index);
        if (idx == null) return '';
        return this.chunk({ tool_calls: [{ index: idx, function: { arguments: e.json } }] });
      }
      case 'usage':
        this.usage = {
          prompt_tokens: e.usage.inputTokens ?? 0,
          completion_tokens: e.usage.outputTokens ?? 0,
          total_tokens: (e.usage.inputTokens ?? 0) + (e.usage.outputTokens ?? 0),
        };
        return '';
      case 'stop':
        this.finish =
          e.stopReason === 'tool_use' ? 'tool_calls' : e.stopReason === 'max_tokens' ? 'length' : 'stop';
        return '';
      case 'error':
        return `data: ${JSON.stringify({ error: { message: e.message, type: 'upstream_error' } })}\n\n`;
      default:
        return '';
    }
  }

  end(): string {
    let out = this.chunk({}, this.finish ?? 'stop');
    out += 'data: [DONE]\n\n';
    return out;
  }
}

export function buildOpenAIChatResponse(res: IRResponse, ctx: { requestId: string; model: string; clientModel: string }): any {
  const text = res.blocks.filter((b) => b.type === 'text').map((b: any) => b.text).join('');
  const thinking = res.blocks.filter((b) => b.type === 'thinking').map((b: any) => b.text).join('\n');
  const toolCalls = res.blocks
    .filter((b) => b.type === 'tool_use')
    .map((b: any) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
    }));
  return {
    id: ctx.requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: ctx.clientModel || ctx.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(thinking ? { reasoning_content: thinking } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: res.stopReason === 'tool_use' ? 'tool_calls' : res.stopReason === 'max_tokens' ? 'length' : 'stop',
      },
    ],
    usage: {
      prompt_tokens: res.usage.inputTokens,
      completion_tokens: res.usage.outputTokens,
      total_tokens: res.usage.inputTokens + res.usage.outputTokens,
    },
  };
}
