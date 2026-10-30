// 持久化层入口：把各仓储组合成一个 Store。
import { Db } from './db';
import { ImageTagRepo } from './image-tags';
import { MemoryRepo } from './memory';
import { ScheduledRepo } from './scheduled';
import { SettingsRepo } from './settings';
import type { SettingsLogger } from './settings';
import { PersonaRepo } from './persona';
import { SessionRepo } from './session';
import { SessionSettingsRepo } from './session-settings';
import { UsageRepo, AuditRepo } from './usage';
import type { Box } from '../secret/box';

export class Store {
  readonly db: Db;
  readonly settings: SettingsRepo;
  readonly personas: PersonaRepo;
  readonly sessions: SessionRepo;
  /** 按对话对象的设置覆盖。与 personas 并列，都不依赖 sessions 行存在。 */
  readonly sessionSettings: SessionSettingsRepo;
  readonly usage: UsageRepo;
  readonly audit: AuditRepo;
  readonly imageTags: ImageTagRepo;
  /** 预排的主动消息（"闹钟"）。落库而不是放内存，见 scheduled.ts 顶部说明。 */
  readonly scheduled: ScheduledRepo;
  /** 长期记忆：日摘要、事实、摘要水位线。 */
  readonly memory: MemoryRepo;

  constructor(readonly path: string) {
    this.db = new Db(path);
    this.settings = new SettingsRepo(this.db);
    this.personas = new PersonaRepo(this.db);
    this.sessions = new SessionRepo(this.db);
    this.sessionSettings = new SessionSettingsRepo(this.db);
    this.usage = new UsageRepo(this.db);
    this.audit = new AuditRepo(this.db);
    this.imageTags = new ImageTagRepo(this.db);
    this.scheduled = new ScheduledRepo(this.db);
    this.memory = new MemoryRepo(this.db);
  }

  /** 注入加解密器；之后读写的敏感字段自动走 AES-256-GCM。 */
  setBox(box: Box): void {
    this.settings.setBox(box);
  }

  /** 接上日志：设置读取的降级路径（损坏、解密失败）必须留下痕迹。 */
  setLog(log: SettingsLogger): void {
    this.settings.setLog(log);
  }

  close(): void {
    this.db.close();
  }
}

export { Db } from './db';
export * from './types';
export { SettingsRepo } from './settings';
export { PersonaRepo } from './persona';
export { SessionRepo } from './session';
export { SessionSettingsRepo, type SessionOverrideRow, type OverrideMeta } from './session-settings';
export {
  OVERRIDABLE_GROUPS,
  OVERRIDE_FIELDS,
  GROUP_LABELS,
  overrideKeys,
  groupBase,
  pickBot,
  pickGroups,
  normalizeOverrides,
  resolveSettings,
  overriddenGroups,
  isEmptyOverrides,
  type SessionOverrides,
  type SessionBotOverride,
  type SessionComputerOverride,
  type SessionMemoryOverride,
  type OverridableGroup,
} from './overrides';
export { UsageRepo, AuditRepo } from './usage';
export {
  ScheduledRepo,
  MAX_PENDING_PER_SESSION,
  EXPIRE_AFTER_SEC,
  type ScheduledRow,
  type NewSchedule,
  type ScheduledSource,
  type ScheduledStatus,
} from './scheduled';
export { ImageTagRepo, type ImageTag } from './image-tags';
export {
  MemoryRepo,
  MAX_CONTENT as MAX_MEMORY_CONTENT,
  MAX_PER_OWNER as MAX_MEMORIES_PER_OWNER,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  normalizeContent as normalizeMemoryContent,
  type CursorRow,
  type DaySummary,
  type DigestCandidate,
  type Memory,
  type MemoryKind,
  type MemoryOwner,
  type MemoryScope,
  type MemorySource,
  type NewDaySummary,
  type NewMemory,
} from './memory';
