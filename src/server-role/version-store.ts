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

/** A resource's row with its path and stamp, as a collection's catch-up reads it. */
export type Row = Current & { path: string; stamp: number };

export type WriteOutcome =
  | { outcome: 'written'; version: string; created: boolean }
  | { outcome: 'precondition-failed' }
  | { outcome: 'not-found' };

interface VersionRow extends Record<string, SqlStorageValue> {
  stamp: number;
  contents: string | null;
  deleted: number;
}

/** Told of every write, with the path written, the version it made and whether it deleted. */
export type WriteListener = (path: string, version: string, deleted: boolean) => void;

export class VersionStore {
  readonly #sql: SqlStorage;
  readonly #cutoffWindowMs: number;
  readonly #onWrite?: WriteListener;

  /** `cutoffWindowMs` is how long a superseded row or a deletion stays before a write prunes it. */
  constructor(sql: SqlStorage, options: { cutoffWindowMs: number; onWrite?: WriteListener }) {
    if (!(options.cutoffWindowMs > 0)) throw new RangeError(`The cut-off window must be a positive number of ms, not ${options.cutoffWindowMs}`);
    this.#sql = sql;
    this.#cutoffWindowMs = options.cutoffWindowMs;
    this.#onWrite = options.onWrite;
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
      CREATE TABLE IF NOT EXISTS Horizon (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        stamp INTEGER NOT NULL
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
    return this.#rowWhere(path, 'stamp >= ?', 0);
  }

  /** The path's row at `version`, if this epoch wrote it and A still keeps it. */
  at(path: string, version: string): Current | undefined {
    const stamp = this.#stampOf(version);
    return stamp === undefined ? undefined : this.#rowWhere(path, 'stamp = ?', stamp);
  }

  /** The path's row before the one at `version`, if A still keeps it, as a patch starts from. */
  before(path: string, version: string): Current | undefined {
    const stamp = this.#stampOf(version);
    return stamp === undefined ? undefined : this.#rowWhere(path, 'stamp < ?', stamp);
  }

  /** The path's newest row at or before `stamp`, a cursor's, if A still keeps it. */
  asOf(path: string, stamp: number): Current | undefined {
    return this.#rowWhere(path, 'stamp <= ?', stamp);
  }

  /**
   * The path's newest row, or, for a path with none, never written or its deletion pruned, a
   * deletion at the store's base version, as R37 asks. The base version moves past every pruned
   * deletion, so no path is given one it had before.
   */
  state(path: string): Current {
    return this.current(path) ?? { version: this.#baseVersion(), deleted: true };
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

  /** Every resource's newest row, a deletion A still keeps included, in path order, as the page shows them. */
  held(): { path: string; version: string; deleted: boolean }[] {
    return this.#sql
      .exec<{ path: string; stamp: number; deleted: number }>(
        `SELECT path, stamp, deleted FROM Versions AS v
         WHERE stamp = (SELECT MAX(stamp) FROM Versions WHERE path = v.path)
         ORDER BY path`,
      )
      .toArray()
      .map((row) => ({ path: row.path, version: this.#version(row.stamp), deleted: row.deleted === 1 }));
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

  /** The newest stamp in this epoch, or 0 before its first write. */
  newestStamp(): number {
    return this.#sql.exec<{ stamp: number | null }>('SELECT MAX(stamp) AS stamp FROM Versions').one().stamp ?? 0;
  }

  /**
   * Whether A can still say what changed after `stamp`. A prune keeps each live resource's newest
   * row, so only a dropped deletion loses a change, and the horizon is the newest one dropped. It
   * costs a read and no write.
   */
  keepsEverythingAfter(stamp: number): boolean {
    return stamp >= this.#horizon();
  }

  /**
   * Each path's newest row, if it is stamped after `stamp`, deletions included, in the order of
   * those stamps, for the paths `covers` accepts, up to `limit`.
   */
  changedAfter(stamp: number, covers: (path: string) => boolean, limit: number): Row[] {
    return this.#rows(
      `SELECT path, stamp, contents, deleted FROM Versions AS v
       WHERE stamp > ? AND stamp = (SELECT MAX(stamp) FROM Versions WHERE path = v.path)
       ORDER BY stamp`,
      stamp,
      covers,
      limit,
    );
  }

  /** Each live resource after `afterPath`, in path order, for the paths `covers` accepts, up to `limit`. */
  liveAfter(afterPath: string, covers: (path: string) => boolean, limit: number): Row[] {
    return this.#rows(
      `SELECT path, stamp, contents, deleted FROM Versions AS v
       WHERE path > ? AND deleted = 0 AND stamp = (SELECT MAX(stamp) FROM Versions WHERE path = v.path)
       ORDER BY path`,
      afterPath,
      covers,
      limit,
    );
  }

  /**
   * Empties the store and raises the epoch, as a Wipe does. The epoch survives, so no version
   * minted after is one minted before.
   */
  wipe(): number {
    const epoch = this.epoch() + 1;
    this.#sql.exec('DELETE FROM Versions');
    this.#sql.exec('DELETE FROM Horizon');
    this.#sql.exec('INSERT OR REPLACE INTO Epoch (id, value) VALUES (1, ?)', epoch);
    return epoch;
  }

  // The path's newest row that `where` admits, as a version of this epoch.
  #rowWhere(path: string, where: string, stamp: number): Current | undefined {
    const row = this.#sql.exec<VersionRow>(`SELECT stamp, contents, deleted FROM Versions WHERE path = ? AND ${where} ORDER BY stamp DESC LIMIT 1`, path, stamp).toArray()[0];
    if (!row) return undefined;
    const version = this.#version(row.stamp);
    return row.deleted ? { version, deleted: true } : { version, deleted: false, contents: row.contents! };
  }

  // A version's stamp, if it is a row's version in this epoch, never a base version.
  #stampOf(version: string): number | undefined {
    const match = /^e(\d+)\.(\d+)$/.exec(version);
    return match && Number(match[1]) === this.epoch() ? Number(match[2]) : undefined;
  }

  #rows(query: string, from: string | number, covers: (path: string) => boolean, limit: number): Row[] {
    const rows: Row[] = [];
    for (const row of this.#sql.exec<VersionRow & { path: string }>(query, from)) {
      if (!covers(row.path)) continue;
      const version = this.#version(row.stamp);
      rows.push(row.deleted ? { path: row.path, stamp: row.stamp, version, deleted: true } : { path: row.path, stamp: row.stamp, version, deleted: false, contents: row.contents! });
      if (rows.length === limit) break;
    }
    return rows;
  }

  #live(path: string): Current | undefined {
    const current = this.current(path);
    return current && !current.deleted ? current : undefined;
  }

  // The insert comes before the prune, in one synchronous block, so a pruned top row never
  // lends its rowid, and so its version, to the next write. The write is delivered before the
  // prune too, so a patch can start from the version the write supersedes, however old.
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
    const version = this.#version(stamp);
    this.#onWrite?.(path, version, contents === null);
    this.#prune(now);
    return version;
  }

  // Drops rows older than the cut-off window, but keeps each live resource's newest row. It
  // reads every row on each write, since an index on writtenAt would cost a write per insert
  // and reads cost a thousandth as much.
  #prune(now: Date): void {
    const cutoff = new Date(now.getTime() - this.#cutoffWindowMs).toISOString();
    // Every deletion older than the cut-off goes, and leaves its path with no row, so the base
    // version moves past the newest of them. That is a write only when a prune drops a deletion.
    const { horizon } = this.#sql.exec<{ horizon: number | null }>('SELECT MAX(stamp) AS horizon FROM Versions WHERE writtenAt < ? AND deleted = 1', cutoff).one();
    this.#sql.exec(
      `DELETE FROM Versions
       WHERE writtenAt < ?
         AND (deleted = 1 OR stamp < (SELECT MAX(stamp) FROM Versions AS v WHERE v.path = Versions.path))`,
      cutoff,
    );
    if (horizon !== null && horizon > this.#horizon()) this.#sql.exec('INSERT OR REPLACE INTO Horizon (id, stamp) VALUES (1, ?)', horizon);
  }

  #horizon(): number {
    return this.#sql.exec<{ stamp: number }>('SELECT stamp FROM Horizon').toArray()[0]?.stamp ?? 0;
  }

  // A base version is never a row's version, which is only digits after the epoch.
  #baseVersion(): string {
    return `e${this.epoch()}.b${this.#horizon()}`;
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
