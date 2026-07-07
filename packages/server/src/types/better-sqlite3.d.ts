/**
 * Minimal type declarations for better-sqlite3 (the package ships none and
 * this repo avoids adding new dependencies). Only the surface openloom-server
 * uses is declared; everything is strictly typed at the call sites.
 */
declare module 'better-sqlite3' {
  interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Statement<BindParameters extends unknown[] = unknown[]> {
    run(...params: BindParameters): RunResult;
    get(...params: BindParameters): unknown;
    all(...params: BindParameters): unknown[];
  }

  interface DatabaseOptions {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  class Database {
    constructor(filename: string, options?: DatabaseOptions);
    prepare<BindParameters extends unknown[] = unknown[]>(sql: string): Statement<BindParameters>;
    exec(sql: string): this;
    pragma(pragma: string, options?: { simple?: boolean }): unknown;
    transaction<F extends (...args: never[]) => unknown>(fn: F): F;
    close(): void;
    readonly open: boolean;
  }

  export = Database;
}
