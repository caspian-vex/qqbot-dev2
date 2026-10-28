// 持久化层入口：把各仓储组合成一个 Store。
import { Db } from './db';
import { ImageTagRepo } from './image-tags';
import { SettingsRepo } from './settings';
import { PersonaRepo } from './persona';
import { SessionRepo } from './session';
import { UsageRepo, AuditRepo } from './usage';
import type { Box } from '../secret/box';

export class Store {
  readonly db: Db;
  readonly settings: SettingsRepo;
  readonly personas: PersonaRepo;
  readonly sessions: SessionRepo;
  readonly usage: UsageRepo;
  readonly audit: AuditRepo;
  readonly imageTags: ImageTagRepo;

  constructor(readonly path: string) {
    this.db = new Db(path);
    this.settings = new SettingsRepo(this.db);
    this.personas = new PersonaRepo(this.db);
    this.sessions = new SessionRepo(this.db);
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
export { UsageRepo, AuditRepo } from './usage';
export { ImageTagRepo, type ImageTag } from './image-tags';
