// A's store of versions. Every write adds a row, a deletion adds one marked deleted, and a
// row's stamp, its SQLite rowid, is the version under the epoch, as `e0.17`. It takes `sql`
// and nothing else from its host, so it runs wherever SQLite storage does.

/** A version precondition: `'*'` for any current version, or the versions that pass. */
export type VersionCondition = '*' | string[];

export interface Preconditions {
  /** Passes only when the resource exists at one of these versions, as HTTP's `If-Match`. */
  ifMatch?: VersionCondition;
  /** Passes only when the resource is not at one of these versions, as `If-None-Match`. */
  ifNoneMatch?: VersionCondition;
}

/** A resource's newest row. A deletion has a version of its own and no contents. */
export type Current =
  | { version: string; deleted: false; contents: string }
  | { version: string; deleted: true };

export type WriteOutcome =
  | { outcome: 'written'; version: string; created: boolean }
  | { outcome: 'precondition-failed' }
  | { outcome: 'not-found' };

interface VersionRow extends Record<string, SqlStorageValue> {
  stamp: number;
  contents: string | null;
  deleted: number;
}

export class VersionStore {
  readonly #sql: SqlStorage;
  readonly #cutoffWindowMs: number;

  /** `cutoffWindowMs` is how long a superseded row or a deletion stays before a write prunes it. */
  constructor(sql: SqlStorage, options: { cutoffWindowMs: number }) {
    if (!(options.cutoffWindowMs > 0)) throw new RangeError(`The cut-off window must be a positive number of ms, not ${options.cutoffWindowMs}`);
    this.#sql = sql;
    this.#cutoffWindowMs = options.cutoffWindowMs;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS Versions (
        stamp INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        contents TEXT,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        writtenAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_Versions_path ON Versions(path);
      CREATE TABLE IF NOT EXISTS Epoch (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL
      );
    `);
  }

  /** How many times A has been wiped. Versions carry it, so none repeats across a Wipe. */
  epoch(): number {
    const row = this.#sql.exec<{ value: number }>('SELECT value FROM Epoch').toArray()[0];
    return row?.value ?? 0;
  }

  /** The newest row for a path relative to A's root, as `/notes/inbox/note-42`. */
  current(path: string): Current | undefined {
    const row = this.#sql
      .exec<VersionRow>(
        'SELECT stamp, contents, deleted FROM Versions WHERE path = ? ORDER BY stamp DESC LIMIT 1',
        path,
      )
      .toArray()[0];
    if (!row) return undefined;
    const version = this.#version(row.stamp);
    return row.deleted ? { version, deleted: true } : { version, deleted: false, contents: row.contents! };
  }

  /** Writes `contents` as the path's new version, if the preconditions pass. */
  put(path: string, contents: string, preconditions: Preconditions = {}): WriteOutcome {
    const live = this.#live(path);
    if (!passes(live?.version, preconditions)) return { outcome: 'precondition-failed' };
    return { outcome: 'written', version: this.#add(path, contents), created: !live };
  }

  /**
   * Adds a deletion as the path's new version, if the resource exists and the preconditions pass.
   * A missing resource is `not-found` whatever the preconditions say, as RFC 9110 ignores them
   * when the answer without them would be 404.
   */
  delete(path: string, preconditions: Preconditions = {}): WriteOutcome {
    const live = this.#live(path);
    if (!live) return { outcome: 'not-found' };
    if (!passes(live.version, preconditions)) return { outcome: 'precondition-failed' };
    return { outcome: 'written', version: this.#add(path, null), created: false };
  }

  /** The paths of every live resource under a folder, at any depth, in path order. */
  members(folder: string): string[] {
    // A range, not a LIKE pattern, which DO SQLite caps at 50 bytes. The trailing slash keeps
    // `/notes/inbox2/...` out of `/notes/inbox`, and `0` is the character after `/`.
    return this.#sql
      .exec<{ path: string }>(
        `SELECT path FROM Versions AS v
         WHERE path >= ? AND path < ? AND deleted = 0
           AND stamp = (SELECT MAX(stamp) FROM Versions WHERE path = v.path)
         ORDER BY path`,
        `${folder}/`,
        `${folder}0`,
      )
      .toArray()
      .map((row) => row.path);
  }

  #live(path: string): Current | undefined {
    const current = this.current(path);
    return current && !current.deleted ? current : undefined;
  }

  // The insert comes before the prune, in one synchronous block, so a pruned top row never
  // lends its rowid, and so its version, to the next write.
  #add(path: string, contents: string | null): string {
    const now = new Date();
    const { stamp } = this.#sql
      .exec<{ stamp: number }>(
        'INSERT INTO Versions (path, contents, deleted, writtenAt) VALUES (?, ?, ?, ?) RETURNING stamp',
        path,
        contents,
        contents === null ? 1 : 0,
        now.toISOString(),
      )
      .one();
    this.#prune(now);
    return this.#version(stamp);
  }

  // Drops rows older than the cut-off window, but keeps each live resource's newest row. It
  // reads every row on each write, since an index on writtenAt would cost a write per insert
  // and reads cost a thousandth as much.
  #prune(now: Date): void {
    const cutoff = new Date(now.getTime() - this.#cutoffWindowMs).toISOString();
    this.#sql.exec(
      `DELETE FROM Versions
       WHERE writtenAt < ?
         AND (deleted = 1 OR stamp < (SELECT MAX(stamp) FROM Versions AS v WHERE v.path = Versions.path))`,
      cutoff,
    );
  }

  #version(stamp: number): string {
    return `e${this.epoch()}.${stamp}`;
  }
}

/** Whether a resource at `liveVersion`, or missing when it is undefined, passes the preconditions. */
export function passes(liveVersion: string | undefined, { ifMatch, ifNoneMatch }: Preconditions): boolean {
  if (ifMatch && !matches(liveVersion, ifMatch)) return false;
  if (ifNoneMatch && matches(liveVersion, ifNoneMatch)) return false;
  return true;
}

function matches(liveVersion: string | undefined, condition: VersionCondition): boolean {
  if (liveVersion === undefined) return false;
  return condition === '*' || condition.includes(liveVersion);
}
