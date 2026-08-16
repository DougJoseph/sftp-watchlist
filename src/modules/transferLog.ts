// FORK ADDITION (DougJoseph, 2026-08-15) — see CHANGELOG "Fork changes".
//
// The upstream extension logs only to the VS Code Output panel, which clears.
// After a sync there was no record on disk of what went where, which made it
// impossible to answer "what did I push to which server, and when" after the
// fact. This writes the same lines the panel receives to a monthly file inside
// the local folder the running config governs.
//
// Location: <config local base>/sftp-transfer-logs/sftp-transfer-YYYY-MM.log
//
// Monthly files rather than numbered rotation on purpose: "what happened on
// 15 August" should be a filename, not a search through .log.3.
//
// The folder sits inside a synced tree, so every consuming project must carry
// `/sftp-transfer-logs` in its sftp.json ignore list, or the logs would upload
// themselves.

import * as fs from 'fs';
import * as fse from 'fs-extra';
import * as path from 'path';
import { LogSink } from '../logger';

export const TRANSFER_LOG_DIR = 'sftp-transfer-logs';

const FILE_PREFIX = 'sftp-transfer-';
const FILE_SUFFIX = '.log';
const DEFAULT_KEEP_MONTHS = 24;

function pad(n: number): string {
  return ('00' + n).slice(-2);
}

export function transferLogDir(localBase: string): string {
  return path.join(localBase, TRANSFER_LOG_DIR);
}

export function transferLogFile(localBase: string, when: Date): string {
  const stamp = `${when.getFullYear()}-${pad(when.getMonth() + 1)}`;
  return path.join(transferLogDir(localBase), `${FILE_PREFIX}${stamp}${FILE_SUFFIX}`);
}

// Deletes monthly files beyond the retention count. Newest are kept; the
// filenames sort chronologically because they are zero-padded YYYY-MM.
function prune(dir: string, keepMonths: number) {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return;
  }

  const logs = entries
    .filter(name => name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX))
    .sort();

  const excess = logs.length - keepMonths;
  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(path.join(dir, logs[i]));
    } catch (e) {
      // A file we cannot remove is not worth failing a transfer over.
    }
  }
}

/**
 * Returns a sink that appends to this config's current monthly log, or null if
 * the log is disabled or its folder cannot be created.
 *
 * Appends synchronously rather than holding a stream open: lines then survive a
 * crash mid-transfer, and there is no stream lifetime to get wrong. The cost is
 * a few tens of microseconds per line, which is immaterial against a network
 * transfer.
 */
export function createTransferLogSink(
  localBase: string,
  enabled: boolean | undefined,
  keepMonths: number | undefined
): LogSink | null {
  if (enabled === false) {
    return null;
  }
  if (!localBase) {
    return null;
  }

  const dir = transferLogDir(localBase);
  try {
    // fs-extra rather than fs.mkdirSync's `recursive` option: the project's
    // pinned @types/node predates that option, and fs-extra is already a
    // dependency here.
    fse.ensureDirSync(dir);
  } catch (e) {
    // Cannot create the folder: run without a file log rather than block a push.
    return null;
  }

  prune(dir, keepMonths && keepMonths > 0 ? keepMonths : DEFAULT_KEEP_MONTHS);

  return function append(line: string) {
    // Resolved per line so an operation running across midnight on the last day
    // of a month still lands each line in the file for its own month.
    const file = transferLogFile(localBase, new Date());
    fs.appendFileSync(file, line + '\n');
  };
}
