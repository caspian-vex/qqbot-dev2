// OneBot v11 动作封装。
//
// 单独一个文件而不是塞进 client.ts：client 只管连接与协议帧，
// 动作列表会随需求增长，混在一起会让"连接逻辑"被业务细节淹没。
import type { Client } from './client';
import type { Segment } from './types';

export interface LoginInfo {
  user_id: number;
  nickname: string;
}

export interface GroupInfo {
  group_id: number;
  group_name: string;
  member_count: number;
  max_member_count: number;
}

export interface FriendInfo {
  user_id: number;
  nickname: string;
  remark: string;
}

interface SendResult {
  message_id: number;
}

function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

/** 查询当前登录账号。 */
export async function getLoginInfo(c: Client, signal?: AbortSignal): Promise<LoginInfo> {
  const data = (await c.call('get_login_info', {}, signal)) as Partial<LoginInfo> | undefined;
  return {
    user_id: Number(data?.user_id ?? 0),
    nickname: String(data?.nickname ?? ''),
  };
}

export async function getGroupList(c: Client, signal?: AbortSignal): Promise<GroupInfo[]> {
  return asArray<GroupInfo>(await c.call('get_group_list', {}, signal));
}

export async function getFriendList(c: Client, signal?: AbortSignal): Promise<FriendInfo[]> {
  return asArray<FriendInfo>(await c.call('get_friend_list', {}, signal));
}

/**
 * 协议端是否真的在线。
 *
 * 连接在 ≠ QQ 在线：NapCat 掉线时 WebSocket 仍然通，
 * 所以总览页的"在线"必须问 get_status，不能只看 connected。
 */
export async function getOnline(c: Client, signal?: AbortSignal): Promise<boolean> {
  const data = (await c.call('get_status', {}, signal)) as
    | { online?: boolean; good?: boolean }
    | undefined;
  return data?.online === true && data?.good === true;
}

export async function sendGroupMsg(
  c: Client,
  groupId: number,
  segs: Segment[],
  signal?: AbortSignal,
): Promise<number> {
  const data = (await c.call(
    'send_group_msg',
    { group_id: groupId, message: segs, auto_escape: false },
    signal,
  )) as Partial<SendResult> | undefined;
  return Number(data?.message_id ?? 0);
}

export async function sendPrivateMsg(
  c: Client,
  userId: number,
  segs: Segment[],
  signal?: AbortSignal,
): Promise<number> {
  const data = (await c.call(
    'send_private_msg',
    { user_id: userId, message: segs, auto_escape: false },
    signal,
  )) as Partial<SendResult> | undefined;
  return Number(data?.message_id ?? 0);
}

/** 给面板用的适配器：把动作封装成 OneBotPort。 */
export function portOf(c: Client) {
  return {
    status: () => c.status(),
    getOnline: (signal?: AbortSignal) => getOnline(c, signal),
    sendGroupMsg: (id: number, text: string, signal?: AbortSignal) =>
      sendGroupMsg(c, id, [{ type: 'text', data: { text } }], signal),
    sendPrivateMsg: (id: number, text: string, signal?: AbortSignal) =>
      sendPrivateMsg(c, id, [{ type: 'text', data: { text } }], signal),
    getGroupList: (signal?: AbortSignal) => getGroupList(c, signal),
    getFriendList: (signal?: AbortSignal) => getFriendList(c, signal),
  };
}
