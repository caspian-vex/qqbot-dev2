// 让机器人自己排一条"到点说这句话"的闹钟。
//
// 为什么值得给模型这个工具：用户说的"明早八点提醒我"如果只能靠模型
// 记住，下一轮上下文一裁就没了；而"到点主动说话"这件事本身又需要
// 一个不依赖进程存活的时间源。工具 + 落库正好把两头都解决。
//
// 为什么不做审批：与跑命令、改文件不同，它没有副作用——只在库里加一行，
// 发的时候还要过日限与免打扰之外的额度检查。为一句"八点叫我"让用户
// 去面板点批准，功能就废了。权限门槛沿用电脑操作那一套（谁能用谁才能排）。
import type { ToolDef } from '../llm/client';

export const REMIND_TOOL_NAME = 'schedule_message';

/** 最短 1 分钟：再短就不是"定时"，是"马上说"，那该直接回。 */
export const MIN_REMIND_MINUTES = 1;

/** 最长 7 天：再远的承诺模型记不住上下文，用户也早忘了自己说过。 */
export const MAX_REMIND_MINUTES = 7 * 24 * 60;

/** 原话长度上限。太长的"原话"等于把整段回复塞进闹钟。 */
export const MAX_REMIND_BODY = 300;

/**
 * 已过点的 HH:MM 视为"明天这个点"。
 *
 * 30 秒的宽限是给"现在是 8:00:05，模型算出来 8:00"这种情况留的余地：
 * 不留的话它会排到明天，而用户要的是现在。
 */
const GRACE_MS = 30_000;

export const REMIND_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: REMIND_TOOL_NAME,
    description:
      '安排一条到点由你主动发出的消息。只在用户明确要求"到点提醒我/叫我/跟我说一声"时使用，' +
      '不要用它做普通的延迟回复（回复一条消息不需要定时）。' +
      '到点后这条消息会自己发出去，不需要用户再说话；如果用户中途取消，你可以再用一次带 cancel 的调用撤掉。',
    parameters: {
      type: 'object',
      properties: {
        at: {
          type: 'string',
          description:
            '当天的钟点，24 小时制 "HH:MM"，例如 "08:00"、"21:30"。已经过去的钟点按明天算。' +
            '与 after_minutes 二选一，两个都给时以 at 为准。',
        },
        after_minutes: {
          type: 'number',
          description: '从现在起多少分钟后发。范围 1-10080（7 天）。适合"二十分钟后叫我"这种相对时间。',
        },
        text: {
          type: 'string',
          description:
            '到点要说的话。写用户会听到的原话（例如"该交房租了"），不要写指令。' +
            `留空表示到点由你自己组织一句。最多 ${MAX_REMIND_BODY} 字。`,
        },
        cancel: {
          type: 'boolean',
          description: '传 true 表示撤销这个会话里所有还没发出的定时消息，此时不需要 at / after_minutes。',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

/**
 * 注入 system 的使用说明。
 *
 * 光靠 tools 里的 description 不够：模型看到"能定时"就容易对每句话都用，
 * 于是"我一会儿再回你"变成一条十分钟后的消息。这里把边界说死。
 */
export const REMIND_PROMPT = [
  '你可以让一条消息在将来某个时刻自己发出去（schedule_message）。',
  '- 只在用户明确要求"到点提醒/叫我/跟我说一声"时用；不要用它来延迟回答普通问题。',
  '- 时间用 "HH:MM"（已过去的钟点按明天算）或 after_minutes，不要把日期算错。',
  '- text 写用户会听到的原话；不知道说什么就留空，到点你自己组织。',
  '- 用户说"算了/不用了"时，用 cancel 撤掉。',
].join('\n');

export interface DueOk {
  dueAt: number;
  /** 给人看的一句话，回灌给模型时用得上。 */
  note: string;
}

export interface DueErr {
  error: string;
}

/** 工具调用参数解析后的形状。缺字段一律给安全的默认值。 */
export interface RemindArgs {
  at: string;
  after: number;
  text: string;
  cancel: boolean;
}

/**
 * 解析模型的原始参数。
 *
 * 模型给的 arguments 永远是字符串，且经常夹带多余字段或类型不对
 * （number 写成 string）。这里一律收敛，宁可退回默认值也不要抛错——
 * 抛错会让整条回复走兜底话术，而"闹钟没排上"其实可以好好解释一句。
 */
export function readRemindArgs(raw: string): RemindArgs {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      v = parsed as Record<string, unknown>;
    }
  } catch {
    // 解析失败：下面全用默认值，最终会走到"参数不对"的提示
  }
  const num = (x: unknown): number => {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
    return Number.NaN;
  };
  return {
    at: typeof v['at'] === 'string' ? v['at'] : '',
    after: num(v['after_minutes']),
    text: typeof v['text'] === 'string' ? v['text'] : '',
    cancel: v['cancel'] === true,
  };
}

/**
 * 把工具参数换算成绝对时间。
 *
 * 刻意只认 "HH:MM" 和相对分钟两种：让模型自己算"明天早上八点是几号"
 * 是它最容易出错的地方，而错了的表现是"提醒晚了一天"，很难被发现。
 */
export function parseDueAt(at: string, afterMinutes: number, now: Date): DueOk | DueErr {
  const a = at.trim();
  if (a !== '') {
    const m = /^(\d{1,2}):(\d{2})$/.exec(a);
    if (!m) return { error: '时间格式只认 24 小时制的 "HH:MM"，例如 "08:00"' };
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h > 23 || mm > 59) return { error: `"${a}" 不是合法的钟点` };

    const d = new Date(now);
    d.setHours(h, mm, 0, 0);
    if (d.getTime() <= now.getTime() + GRACE_MS) d.setDate(d.getDate() + 1);
    return { dueAt: d.getTime(), note: '' };
  }

  if (!Number.isFinite(afterMinutes)) {
    return { error: '要么给 at（"HH:MM"），要么给 after_minutes' };
  }
  const min = Math.round(afterMinutes);
  if (min < MIN_REMIND_MINUTES) return { error: `至少要在 ${MIN_REMIND_MINUTES} 分钟之后` };
  if (min > MAX_REMIND_MINUTES) return { error: '最多只能排到 7 天以内' };
  return { dueAt: now.getTime() + min * 60_000, note: '' };
}
