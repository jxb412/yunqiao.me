// The package's UMD entry resolves relative modules at runtime in a bundled Electron main process.
import { applyEdits, getNodeValue, modify, parseTree, type ParseError } from 'jsonc-parser/lib/esm/main.js';

/** Gemini CLI strips comments before JSON.parse. Trailing commas are still invalid. */
export function parseGeminiSettings(text: string): Record<string, any> {
  const errors: ParseError[] = [];
  const root = parseTree(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: false });
  if (errors.length || root?.type !== 'object') throw new Error('Gemini settings.json 需要有效的 JSON 对象，可以包含注释。请检查原文件。');
  return getNodeValue(root);
}

export function patchGeminiSettings(original: string, model: string): string {
  const settings = parseGeminiSettings(original);
  const authType = 'gemini-api-key';
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  let text = original.slice(bom.length);
  const formattingOptions = { insertSpaces: !/^\t+\S/m.test(text), tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' };
  try {
    if (settings.security?.auth?.selectedType !== authType) {
      text = applyEdits(text, modify(text, ['security', 'auth', 'selectedType'], authType, { formattingOptions }));
    }
    if (settings.model?.name !== model) {
      text = applyEdits(text, modify(text, ['model', 'name'], model, { formattingOptions }));
    }
  } catch { throw new Error('Gemini settings.json 中的 security、auth 和 model 必须是对象，请核对后重新预览。'); }
  const updated = parseGeminiSettings(text);
  if (updated.security?.auth?.selectedType !== authType || updated.model?.name !== model) {
    throw new Error('Gemini settings.json 中的认证或模型设置存在重复字段，请核对后重新预览。');
  }
  return bom + text;
}

/** Arbitrary comments, MCP arguments and extension settings can contain credentials. */
export function previewGeminiSettings(text: string): string {
  if (!text) return '';
  const { security, model } = parseGeminiSettings(text);
  return JSON.stringify({
    ...(typeof security?.auth?.selectedType === 'string' ? { security: { auth: { selectedType: security.auth.selectedType } } } : {}),
    ...(typeof model?.name === 'string' ? { model: { name: model.name } } : {}),
  }, null, 2);
}
