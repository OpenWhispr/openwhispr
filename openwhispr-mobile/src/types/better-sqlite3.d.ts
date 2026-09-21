declare module 'better-sqlite3' {
  export interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
    nativeBinding?: string;
  }

  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  export interface Statement {
    run(...params: unknown[]): RunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
  }

  export interface Database {
    prepare(source: string): Statement;
    exec(source: string): this;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
    pragma(source: string, options?: { simple?: boolean }): unknown;
  }

  export default class BetterSqlite3Database implements Database {
    constructor(filename: string, options?: Options);
    prepare(source: string): Statement;
    exec(source: string): this;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
    pragma(source: string, options?: { simple?: boolean }): unknown;
  }
}
