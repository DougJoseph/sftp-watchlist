import * as output from './ui/output';
import { getExtensionSetting } from './modules/ext';

const extSetting = getExtensionSetting();
const debug = extSetting.debug || extSetting.printDebugLog;

const paddingTime = time => ('00' + time).slice(-2);

export interface Logger {
  trace(message: string, ...args: any[]): void;
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string | Error, ...args: any[]): void;
  critical(message: string | Error, ...args: any[]): void;
}

// FORK ADDITION (DougJoseph, 2026-08-15): an optional second destination for
// everything the Output panel receives. The panel clears; a file does not.
//
// It is a single mutable sink rather than a permanent one because the log is
// per-project: createFileHandler points this at the log belonging to the config
// running the operation, and clears it when the operation ends. Lines emitted
// outside an operation (activation, config loads) therefore have no project to
// belong to and stay panel-only, which is deliberate.
export type LogSink = (line: string) => void;

let fileSink: LogSink | null = null;

export function setLogSink(sink: LogSink | null) {
  fileSink = sink;
}

export function getLogSink(): LogSink | null {
  return fileSink;
}

// Mirrors ui/output.print's formatting exactly, so the file and the panel can
// never disagree about what a line said.
function formatArgs(args: any[]): string {
  return args
    .map(arg => {
      if (!arg) {
        return arg;
      }

      if (arg instanceof Error) {
        return arg.stack;
      } else if (!arg.toString || arg.toString() === '[object Object]') {
        return JSON.stringify(arg);
      }

      return arg;
    })
    .join(' ');
}

class VSCodeLogger implements Logger {
  log(message: string, ...args: any[]) {
    const now = new Date();
    const month = paddingTime(now.getMonth() + 1);
    const date = paddingTime(now.getDate());
    const h = paddingTime(now.getHours());
    const m = paddingTime(now.getMinutes());
    const s = paddingTime(now.getSeconds());
    const stamp = `[${month}-${date} ${h}:${m}:${s}]`;

    output.print(stamp, message, ...args);

    // FORK ADDITION: tee to the current project's transfer log, if one is set.
    // Wrapped because a logging failure must never break a transfer.
    if (fileSink) {
      try {
        // The file carries the full year, which the panel's stamp omits — a log
        // read months later needs it.
        const y = now.getFullYear();
        fileSink(`[${y}-${month}-${date} ${h}:${m}:${s}] ${formatArgs([message, ...args])}`);
      } catch (e) {
        // Deliberately silent: reporting it here would recurse through log().
      }
    }
  }

  trace(message: string, ...args: any[]) {
    if (debug) {
      this.log('[trace]', message, ...args);
    }
  }

  debug(message: string, ...args: any[]) {
    if (debug) {
      this.log('[debug]', message, ...args);
    }
  }

  info(message: string, ...args: any[]) {
    this.log('[info]', message, ...args);
  }

  warn(message: string, ...args: any[]) {
    this.log('[warn]', message, ...args);
  }

  error(message: string | Error, ...args: any[]) {
    this.log('[error]', message, ...args);
  }

  critical(message: string | Error, ...args: any[]) {
    this.log('[critical]', message, ...args);
  }
}

const logger = new VSCodeLogger();

export default logger;
