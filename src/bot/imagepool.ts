// 图池：给模型一个"可以发图"的选择权。
//
// 设计思路：图池就是数据目录下的一个普通文件夹，用户往里放图片即可。
// 引擎每次回复时把池内文件名注入系统提示，并告诉模型：想发图就在
// 回复末尾单独一行写 [图:文件名]。引擎解析这个标记，把文件转成
// image 消息段发出——模型只需要"决定"，不需要关心文件路径。
//
// 为什么用标记而不是让模型直接输出路径：模型会编造路径、会输出
// 没有的文件名，甚至可能拼出 ../ 之类的东西。把可选范围收窄成
// "一张白名单清单里的名字"，解析端才有底气拒绝一切越界请求。
//
// 全部纯函数：不碰文件系统的部分单独可测，碰文件系统的只有一个
// listImages，失败时静默返回空数组（图池读不了不该挡住聊天）。

import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 允许进图池的扩展名。名单之外的文件一律视为不存在。 */
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/** 图池里最多列出多少个文件名给模型看，防止池子大了把提示词撑爆。 */
export const MAX_LISTED = 40;

/**
 * 列出图池里的图片文件名（按名称排序）。
 *
 * 目录不存在或读失败都返回空数组：图池是锦上添花的能力，
 * 任何文件系统层面的意外都不该变成一次报错。
 */
export function listImages(dir: string): string[] {
  if (dir === '') return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => IMAGE_EXTS.has(extname(n).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * 从模型回复里抽出所有发图标记，并把它们从正文里剥掉。
 *
 * 同时认半角 [图:xxx] 与全角【图：xxx】——模型在中文语境里
 * 经常自作主张换成全角括号，解析端兼容比在提示词里反复强调更可靠。
 * 未解析成功（池子关着、文件不存在）时标记也一并剥掉：
 * 宁可少发一张图，也不能把 "[图:xx]" 这串符号当聊天内容发出去。
 */
export function extractImageTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const body = text.replace(/[【[]\s*图\s*[:：]\s*([^\]】]{1,120}?)\s*[】\]]/g, (_m, name: string) => {
    tags.push(name.trim());
    return '';
  });
  return { text: body.trim(), tags };
}

/**
 * 把模型点名的文件匹配到图池里的真实文件名。
 *
 * 三级匹配：全名精确 → 忽略大小写 → 按去掉扩展名的主名匹配
 * （模型经常只写"风景 01"不写后缀）。全部落空返回 null——
 * 拒绝模糊匹配（比如前缀相似就当命中），否则"猫1.jpg"会被
 * 错发成"猫12.jpg"，这种错发比不发更糟。
 */
export function pickImage(requested: string, files: string[]): string | null {
  const want = requested.trim();
  if (want === '') return null;
  if (files.includes(want)) return want;
  const lower = want.toLowerCase();
  const stemOf = (f: string): string => f.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  return (
    files.find((f) => {
      const fl = f.toLowerCase();
      return fl === lower || stemOf(fl) === lower || stemOf(fl) === stemOf(lower);
    }) ?? null
  );
}

/** 本地文件的 file:// URI。用 Node 的标准函数拼，Windows 盘符才不会拼错。 */
export function imageUri(dir: string, name: string): string {
  return pathToFileURL(join(dir, name)).href;
}

/**
 * 注入系统提示的图池说明块。
 *
 * 放在格式约束之后拼接，且明确"这条优先"——FORMAT_RULES 里有
 * "不要输出占位符"，不显式压一句的话模型会认死理不发图。
 * 只在池子非空时调用，空池子不浪费提示词预算。
 */
export function imagePromptBlock(files: string[], maxPerReply: number): string {
  const listed = files.slice(0, MAX_LISTED);
  const more = files.length > listed.length ? `\n（图池里还有 ${files.length - listed.length} 张，未一一列出）` : '';
  return [
    '',
    '图池：',
    `- 你有一个图池，里面已有的图片：${listed.join('、')}${more}`,
    `- 如果你觉得此刻适合配一张图，就在回复的最末尾单独一行输出 [图:文件名]（名字必须从上面的清单里原样选）`,
    `- 每条回复最多输出 ${maxPerReply} 个图标记；不想发图就不输出，不要提图池本身，也不要解释这个规则`,
  ].join('\n');
}

/** 去重且保序。同一张图点两次名只发一张。 */
export function dedupeKeepOrder(items: string[]): string[] {
  return [...new Set(items)];
}
