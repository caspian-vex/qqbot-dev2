// 持久化层入口：把各仓储组合成一个 Store。
import { Db } from './db';
import { ImageTagRepo } from './image-tags';
import { SettingsRepo } from './settings';
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

  constructor(readonly path: string) {
    this.db = new Db(path);
    this.settings = new SettingsRepo(this.db);
    this.personas = new PersonaRepo(this.db);
    this.sessions = new SessionRepo(this.db);
    this.sessionSettings = new SessionSettingsRepo(this.db);
    this.usage = new UsageRepo(this.db);
    this.audit = new AuditRepo(this.db);
    this.imageTags = new ImageTagRepo(this.db);
  }

  /** 注入加解密器；之后读写的敏感字段自动走 AES-256-GCM。 */
  setBox(box: Box): void {
    this.settings.setBox(box);
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
  type OverridableGroup,
} from './overrides';
export { UsageRepo, AuditRepo } from './usage';
export { ImageTagRepo, type ImageTag } from './image-tags';
