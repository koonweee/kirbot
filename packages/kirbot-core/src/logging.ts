import { format } from "node:util";

export type LoggerLike = Pick<Console, "info" | "warn" | "error">;

export type AppLogLevel = "info" | "warn" | "error";

export type AppLogEntry = {
  timestamp: string;
  source: string;
  level: AppLogLevel;
  message: string;
  args: unknown[];
};

export interface AppLogTarget {
  write(entry: AppLogEntry): void;
}

export function createSourceLogger(target: AppLogTarget, source: string): LoggerLike {
  return {
    info: (...args: unknown[]) => target.write(buildEntry(source, "info", args)),
    warn: (...args: unknown[]) => target.write(buildEntry(source, "warn", args)),
    error: (...args: unknown[]) => target.write(buildEntry(source, "error", args))
  };
}

export function createConsoleLogTarget(baseLogger: LoggerLike = console): AppLogTarget {
  return {
    write(entry) {
      baseLogger[entry.level](`[${entry.source}] ${entry.message}`);
    }
  };
}

function buildEntry(source: string, level: AppLogLevel, args: unknown[]): AppLogEntry {
  return {
    timestamp: new Date().toISOString(),
    source,
    level,
    message: format(...args),
    args
  };
}
