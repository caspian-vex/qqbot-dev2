// 时钟驱动的主动发言：没人说话的时候，机器人要不要开口。
//
// 与回声跟进的分工：
//   echo  刚聊完，对方明确还在 → 隔几十秒补一句（engine.ts）
//   idle  对方说完最后一句，机器人没接住 → 隔几十分钟回头补一句（本文件）
//
// 后者才是用户抱怨"只会问一句回一句"时真正缺的那一半：之前所有主动
// 能力都挂在"收到消息"这件事上，没人说话就永远是死的。
//
// 这里只放**决策**（该不该说、说哪一句的指令），发消息的动作在引擎里，
// 因为它要碰上下文、队列和协议端。决策抽出来才能用假时钟、假随机数测。

/**
 * 闲置唤醒的内部指令。
 *
 * 与 ECHO_INSTRUCTION 一样给模型"闭嘴权"：没有自然想说的就输出空。
 * 这一点是整套主动发言的地基——一个不会闭嘴的机器人，主动发言就必然
 * 变成每天准点的"在干嘛呢"。
 */
export function idleInstruction(
  satForMin: number,
  lastText: string,
  spokeToday = 0,
  dailyLimit = 0,
): string {
  const said = lastText.trim() === '' ? '（对方最后发的是图片或表情）' : `「${lastText.trim()}」`;
  const lines = [
    '（内部指令，用户看不到这段话）',
    `对方上一次说的最后一句是${said}，当时这个话题没有聊完，`,
    `现在已经过去了 ${Math.max(1, Math.round(satForMin))} 分钟。`,
    '如果你确实有自然想说的——想起一件相关的小事、顺口问一句、或者把刚才没说完的补上——',
    '就只输出那一句要直接发送的话。',
    '要求：一句话，口语化；不要用"在吗""在干嘛""怎么不理我"这类催促或试探的开场；',
    '也不要提"刚才""上次""隔了多久"这种时间感，真人不会这么说话。',
  ];
  // 把"今天已经主动过几次"交代给模型，是最便宜的一道自我克制：
  // 它比程序里的日限更懂"这次确实没什么可说的"，而日限只会一刀切。
  if (spokeToday > 0) {
    const cap = dailyLimit > 0 ? `（每天最多 ${dailyLimit} 次）` : '';
    lines.push(
      `注意：今天你已经主动找他说过 ${spokeToday} 次了${cap}，这一次要格外克制——` +
        '除非真的想到了什么有意思的，否则不要开口。',
    );
  }
  lines.push('如果没有自然的内容，只输出一个空字符串。');
  return lines.join('');
}

/**
 * 到点执行一条预排的闹钟时的内部指令。
 *
 * body 非空时引擎直接发原话、不调模型（用户自己定的原话最准），
 * 这段只在 body 为空（"到点你自己说点什么"）时用到。
 */
export function alarmInstruction(minutesLate: number): string {
  const late = minutesLate >= 2 ? `（晚了大约 ${Math.round(minutesLate)} 分钟）` : '';
  return [
    '（内部指令，用户看不到这段话）',
    `你之前答应过对方，到这个时候提醒/说一件事${late}。`,
    '现在时间到了，用一句话自然地说出来，不要提"定时""提醒事项""系统"这类词。',
    '如果没有内容可说，只输出一个空字符串。',
  ].join('');
}

/**
 * 是否处于免打扰时段。
 *
 * 起止小时相等表示不启用（这也是默认之外的"关闭方式"，比再加一个开关省事）。
 * 支持跨零点：23 → 8 表示从晚上十一点到早上八点。
 */
export function inQuietHours(now: Date, startHour: number, endHour: number): boolean {
  const norm = (h: number): number => ((Math.trunc(h) % 24) + 24) % 24;
  const s = norm(startHour);
  // 24 单独处理：写成 0-24 的人想表达"全天静默"，若按 0 归一就成了
  // "起止相同 = 不启用"，意图正好反过来——而且没有任何提示。
  const e = Math.trunc(endHour) === 24 ? 24 : norm(endHour);
  if (s === e) return false;
  const h = now.getHours();
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}

/**
 * 同一会话两次主动开口的最小间隔。
 *
 * 刻意不做成设置项：它不是"用户会调"的参数，而是"别把人烦死"的下限。
 * 面板上每多一个没人懂的旋钮，就多一个配错的机会。
 */
export const IDLE_MIN_GAP_MS = 90 * 60_000;

/** 一个会话在决策时的状态。全部由引擎从库里取，这里不碰数据库。 */
export interface IdleState {
  sid: string;
  kind: string;
  target: number;
  /** 最后一条消息的角色。'user' 表示这句话还没被接住。 */
  lastRole: string;
  /** 最后一条消息的时间（毫秒）。 */
  lastAt: number;
  /** 今天这个会话已经主动说过几句（含闹钟）。 */
  spokeToday: number;
  /** 上次主动开口的时间（毫秒），0 表示今天还没有过。 */
  lastSpokeAt: number;
  /**
   * 闲置门槛（毫秒）：最后一条消息距今超过它才算"被冷落"。
   *
   * 门槛与概率都放在状态里、而不是统一从全局设置读：这两个字段是
   * 可按会话覆盖的。用全局值判断，会出现"我在这个会话里单独开了闲置唤醒，
   * 全局是关的，于是它永远不生效"——而面板上那一组明确写着"独立"。
   */
  holdMs: number;
  /** 开口概率，取自本会话合成后的设置。 */
  rate: number;
  /**
   * 本会话每日上限，同样取自合成后的设置。
   * <= 0 表示这个会话不主动开口。
   */
  dailyLimit: number;
}

export interface IdleOptions {
  now: number;
  /** 进程级剩余额度，见引擎的 PROACTIVE_DAILY_HARD_CAP。 */
  globalLeft: number;
}

export interface IdleDecision {
  /** 选中要开口的会话；null 表示这一轮不说话。 */
  state: IdleState | null;
  /** 为什么说/为什么不说，写日志用。 */
  note: string;
  /** 对方已经等了多久（分钟），喂给提示词。 */
  satForMin: number;
}

/**
 * 每轮 tick 挑一个会话开口（至多一个）。
 *
 * 为什么一次只挑一个：同时给五个人发消息，是这个机器人最像机器的一刻。
 * 排队也一样——宁可这一分钟只理一个人，下一分钟再轮到下一个。
 *
 * 闸门顺序沿用 echo 的"从硬到软"：开关 → 全局额度 → 逐个会话的硬条件
 * → 概率。概率放最后，被拦下时不白白消耗一次骰子。
 */
export function planIdle(
  states: IdleState[],
  o: IdleOptions,
  rand: () => number = Math.random,
): IdleDecision {
  const quiet: IdleDecision = { state: null, note: '未到开口条件', satForMin: 0 };

  if (o.globalLeft <= 0) return { ...quiet, note: '进程级主动消息额度已用尽' };

  const eligible = states.filter(
    (s) =>
      // 只对私聊生效：群里没人叫它就插话，是扰民，也更容易被当成营销号
      s.kind === 'private' &&
      // 最后一句必须是对方说的。机器人自己说的最后一句属于"刚聊完"，
      // 归回声跟进管，两边都管就会变成连环追问。
      s.lastRole === 'user' &&
      // holdMs 为 0 是"这个会话别主动说话"，不是"不限"
      s.holdMs > 0 &&
      o.now - s.lastAt >= s.holdMs &&
      s.dailyLimit > 0 &&
      s.spokeToday < s.dailyLimit &&
      (s.lastSpokeAt === 0 || o.now - s.lastSpokeAt >= IDLE_MIN_GAP_MS),
  );

  if (eligible.length === 0) return { ...quiet, note: '没有符合条件的会话' };

  // 等得最久的先开口：被冷落越久，补一句越自然
  const pick = eligible.reduce((a, b) => (b.lastAt < a.lastAt ? b : a));
  // 概率最后掷：被前面那些硬条件拦下时不白白消耗一次骰子
  if (rand() >= pick.rate) return { ...quiet, note: '未命中概率' };

  return {
    state: pick,
    note: '闲置唤醒',
    satForMin: Math.floor((o.now - pick.lastAt) / 60_000),
  };
}
