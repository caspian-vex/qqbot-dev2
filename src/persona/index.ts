// 把用户写的人格提示词包装成最终的系统提示。

/**
 * 强制追加的输出约束。
 *
 * 为什么必须追加：QQ 不渲染 Markdown。模型默认会输出 **加粗**、## 标题、
 * 表格、有序列表，在 QQ 里就是一堆乱码符号。这段规则用户不可编辑，
 * 避免误删后输出质量断崖式下跌。
 */
export const FORMAT_RULES = `输出要求：
- 纯文本回复，不要使用 Markdown 语法（不要用 **、#、反引号、表格、分隔线）
- 不要用列表符号，需要列举时用「、」或分号连成一句话
- 默认 1-3 句，总长度不超过 120 字；只有用户明确要求详细展开时才加长
- 不要复述用户说过的话，不要说"作为一个AI""我理解你的意思"之类的套话
- 不要输出表情包占位符或颜文字以外的特殊符号`;

/** 可在人格提示词里使用的变量。 */
export interface Vars {
  time: string;
  groupName: string;
  nickname: string;
  botName: string;
}

export function emptyVars(): Vars {
  return { time: '', groupName: '', nickname: '', botName: '' };
}

/**
 * 拼装最终的系统提示词。
 *
 * 结构：用户人格 → 上下文变量 → 格式约束。
 * 变量放在中间而不是塞进用户人格里，是为了让用户改人格时不用关心变量语法。
 */
export function build(systemPrompt: string, v: Vars): string {
  let out = `${systemPrompt.trim()}\n\n`;

  const lines: string[] = [];
  if (v.botName !== '') lines.push(`- 你的名字：${v.botName}`);
  if (v.nickname !== '') lines.push(`- 对方称呼：${v.nickname}`);
  if (v.groupName !== '') lines.push(`- 当前群聊：${v.groupName}`);
  if (v.time !== '') lines.push(`- 当前时间：${v.time}`);

  if (lines.length > 0) {
    out += `上下文：\n${lines.join('\n')}\n\n`;
  }

  return out + FORMAT_RULES;
}

/**
 * 把 {{var}} 占位符替换成实际值。
 *
 * 仅支持 4 个已知变量，未知占位符原样保留，避免误替换用户内容。
 * 一次扫描完成而不是逐条 replaceAll：否则用户把人格写成
 * "{{time}} 里提到 {{nickname}}"，第二遍替换会把第一遍插进去的
 * 文本再扫一遍。
 */
export function expand(s: string, v: Vars): string {
  const table: Record<string, string> = {
    '{{time}}': v.time,
    '{{group_name}}': v.groupName,
    '{{nickname}}': v.nickname,
    '{{bot_name}}': v.botName,
  };
  return s.replace(/\{\{(time|group_name|nickname|bot_name)\}\}/g, (m) => table[m] ?? m);
}
