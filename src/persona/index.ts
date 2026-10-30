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
- 长度跟着内容走：一句话能说完就一句；可以只有一个词（"嗯""行""？"），不要为了显得完整而凑话
- 需要多说时最多 3 句、总长不超过 120 字，只有用户明确要求详细展开时才加长
- 不必回应对方说的每一个点，挑你在意的那一处说
- 不要复述用户说过的话，不要说"作为一个AI""我理解你的意思"之类的套话
- 不要重复自己刚说过的话；问过的问题，不要换个说法再问一遍
- 不要输出表情包占位符或颜文字以外的特殊符号`;

/** 可在人格提示词里使用的变量。 */
export interface Vars {
  time: string;
  groupName: string;
  nickname: string;
  botName: string;
  /**
   * 当前说话人的 QQ 号，空串表示不知道。
   *
   * 类型是 string 而不是 number，是因为它要直接拼进提示词：用数字就会有人
   * 把 `ev.user_id ?? 0` 原样写进来，于是 "0" 变成一条"对方 QQ：0"的假信息。
   * 空串在这里有明确含义——无事件的主动发言、或协议端没带 user_id。
   */
  qq: string;
}

export function emptyVars(): Vars {
  return { time: '', groupName: '', nickname: '', botName: '', qq: '' };
}

/**
 * 拼装最终的系统提示词。
 *
 * 结构：用户人格 → 上下文变量 → [记忆等附加资料] → 格式约束。
 * 变量放在中间而不是塞进用户人格里，是为了让用户改人格时不用关心变量语法。
 *
 * extra 必须在 FORMAT_RULES 之前：格式约束是"怎么说话"，应该最后被读到；
 * 记忆是"以前发生过什么"，是资料不是规则。塞在规则后面，模型容易把
 * 记忆里的句子当成新的指令来执行（"以后叫我哥"会被当成指令而不是事实）。
 */
export function build(systemPrompt: string, v: Vars, extra = ''): string {
  let out = `${systemPrompt.trim()}\n\n`;

  const lines: string[] = [];
  if (v.botName !== '') lines.push(`- 你的名字：${v.botName}`);
  if (v.nickname !== '') lines.push(`- 对方称呼：${v.nickname}`);
  // 号码紧跟在称呼后面：两行说的是同一个人，先"叫什么"再"号是多少"，
  // 模型指代时最不容易串。约束也必须贴在这一行里——
  // 放进 FORMAT_RULES 会同时出现在跟进/主动开口这种压根没有号码的请求里，
  // 那等于告诉模型"你有一个号码但看不到"，反而诱导它编一个出来。
  if (v.qq !== '') lines.push(`- 对方 QQ：${v.qq}（对方问起才说，不要主动提号码）`);
  if (v.groupName !== '') lines.push(`- 当前群聊：${v.groupName}`);
  if (v.time !== '') lines.push(`- 当前时间：${v.time}`);

  if (lines.length > 0) {
    out += `上下文：\n${lines.join('\n')}\n\n`;
  }

  if (extra !== '') {
    out += `${extra}\n\n`;
  }

  return out + FORMAT_RULES;
}

/**
 * 把 {{var}} 占位符替换成实际值。
 *
 * 仅支持 5 个已知变量，未知占位符原样保留，避免误替换用户内容。
 * 一次扫描完成而不是逐条 replaceAll：否则用户把人格写成
 * "{{time}} 里提到 {{nickname}}"，第二遍替换会把第一遍插进去的
 * 文本再扫一遍。
 *
 * {{qq}} 与 {{nickname}} 对称：号码本来就每轮都在上下文里，占位符不增加
 * 任何新的暴露面，只是让"把人写进人设"（"你是 {{nickname}}（{{qq}}）的管家"）
 * 有办法做到。
 */
export function expand(s: string, v: Vars): string {
  const table: Record<string, string> = {
    '{{time}}': v.time,
    '{{group_name}}': v.groupName,
    '{{nickname}}': v.nickname,
    '{{qq}}': v.qq,
    '{{bot_name}}': v.botName,
  };
  return s.replace(/\{\{(time|group_name|nickname|qq|bot_name)\}\}/g, (m) => table[m] ?? m);
}
