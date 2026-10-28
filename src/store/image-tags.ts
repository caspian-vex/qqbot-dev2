// 图池标签的读写。
//
// 库里只放「标签名 + 备注」，图片文件仍然躺在 data/images/<标签>/ 里。
// 这样用户手动往目录拷图也能立刻生效，不需要任何同步动作；
// 备注是唯一必须落库的东西——它是给模型看的说明，盘上没地方存。
import { nowSec } from '../util/time';
import type { Db } from './db';

/** 一个标签的元数据。图片数量不在这里算，由调用方扫目录得到。 */
export interface ImageTag {
  name: string;
  note: string;
  created_at: Date;
}

interface ImageTagRow {
  name: string;
  note: string;
  created_at: number;
}

function toTag(r: ImageTagRow): ImageTag {
  return {
    name: r.name,
    note: r.note,
    created_at: new Date(Number(r.created_at) * 1000),
  };
}

export class ImageTagRepo {
  constructor(private readonly db: Db) {}

  /** 全部标签，按创建时间排序（面板里的顺序因此是稳定的）。 */
  list(): ImageTag[] {
    const rows = this.db.all<ImageTagRow>(
      'SELECT name, note, created_at FROM image_tags ORDER BY created_at, name',
    );
    return rows.map(toTag);
  }

  /** 标签名 → 备注。引擎每次拼提示词都要用，做成一次性取回。 */
  notes(): Map<string, string> {
    const out = new Map<string, string>();
    for (const r of this.db.all<ImageTagRow>('SELECT name, note, created_at FROM image_tags')) {
      out.set(r.name, r.note);
    }
    return out;
  }

  get(name: string): ImageTag | null {
    const row = this.db.get<ImageTagRow>(
      'SELECT name, note, created_at FROM image_tags WHERE name = ?',
      name,
    );
    return row ? toTag(row) : null;
  }

  /**
   * 新建或更新备注。
   *
   * 用 INSERT ... ON CONFLICT 而不是「先查再插」：面板上两个人同时点保存时，
   * 先查再插会有一方撞 UNIQUE 报错，而这里本来就是个幂等的保存语义。
   */
  save(name: string, note: string): void {
    this.db.run(
      `INSERT INTO image_tags (name, note, created_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET note = excluded.note`,
      name,
      note,
      nowSec(),
    );
  }

  /** 改名。目录改名由调用方负责，这里只管库。 */
  rename(from: string, to: string): void {
    const cur = this.get(from);
    if (!cur) {
      this.save(to, '');
      return;
    }
    this.db.run('UPDATE image_tags SET name = ? WHERE name = ?', to, from);
  }

  remove(name: string): void {
    this.db.run('DELETE FROM image_tags WHERE name = ?', name);
  }
}
