// 独立纯模块：仅接受固定枚举，不把用户输入拼接到指令中。
export const DEFAULT_REPORT_PREFERENCES = Object.freeze({
  format: 'structured',
  detail: 'standard',
  tone: 'neutral',
});

const OPTIONS = Object.freeze({
  format: Object.freeze(['structured', 'list', 'narrative']),
  detail: Object.freeze(['concise', 'standard', 'detailed']),
  tone: Object.freeze(['neutral', 'formal', 'conversational']),
});

const INSTRUCTIONS = Object.freeze({
  format: Object.freeze({
    structured: '在各章节内部采用结构化表达，按主题组织内容。',
    list: '在各章节内部采用清晰的列表组织内容。',
    narrative: '在各章节内部采用连贯的叙述方式组织内容。',
  }),
  detail: Object.freeze({
    concise: '详略：简洁，突出关键内容。',
    standard: '详略：适中，覆盖必要内容。',
    detailed: '详略：详细，充分说明相关内容。',
  }),
  tone: Object.freeze({
    neutral: '语气：中性客观。',
    formal: '语气：正式专业。',
    conversational: '语气：自然易读。',
  }),
});

/**
 * 仅接收自身数据属性的精确枚举值；非法或缺失字段回落默认值，其他字段丢弃。
 * 若没有任何合法的显式字段则返回 null，保留「用户未设置」状态。
 * 调用方持久化时应保留 null，而不是预先写入默认对象。
 */
export function normalizeReportPreferences(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const result = { ...DEFAULT_REPORT_PREFERENCES };
  let explicit = false;
  for (const key of Object.keys(OPTIONS)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) continue;
    const value = descriptor.value;
    if (typeof value === 'string' && OPTIONS[key].includes(value)) {
      result[key] = value;
      explicit = true;
    }
  }
  return explicit ? result : null;
}

/** 没有显式有效偏好时返回空字符串，不改变旧报告生成行为。 */
export function buildReportPreferenceInstruction(raw) {
  const preferences = normalizeReportPreferences(raw);
  if (!preferences) return '';
  return [
    '报告表达偏好（仅调整各章节内部的呈现方式）：',
    '保留既有五个 ## 章节及其标题、顺序和来源引用标记，不得破坏或改写这些结构与标记。',
    INSTRUCTIONS.format[preferences.format],
    INSTRUCTIONS.detail[preferences.detail],
    INSTRUCTIONS.tone[preferences.tone],
    '上述偏好不改变证据、引用与真实性要求；不得编造、遗漏必要依据或降低既有要求。',
  ].join('\n');
}
