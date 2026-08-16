// FORK ADDITION (DougJoseph, 2026-08-15) — see CHANGELOG "Fork changes".
//
// Runs a configured shell command to completion BEFORE any local-to-remote
// transfer begins, and aborts the transfer if it fails.
//
// Why before rather than after: the command's job is to produce something that
// must accompany the push (a file-integrity watchlist generated from the exact
// tree about to be sent). A hook that ran afterwards and failed would leave a
// completed push with a stale declaration behind it — precisely the drift the
// hook exists to prevent. Running first means a failure can stop the push.
//
// FAIL CLOSED. Any non-zero exit, timeout, or spawn failure throws, and the
// caller runs this before opening a connection, so nothing has been transferred.
// A hook that failed open would silently reintroduce the drift.

import { exec } from 'child_process';
import logger from '../logger';

const DEFAULT_TIMEOUT_MS = 120000;
const OUTPUT_TAIL_CHARS = 2000;

export interface BeforeUploadContext {
  command: string;
  timeoutMs?: number;
  /** Local root of the config being used — the command's working directory. */
  localBase: string;
  remotePath: string;
  host: string;
  /** Profile or context name from sftp.json, blank when the config has none. */
  profile: string;
  /** The specific file or folder the user acted on. */
  targetLocal: string;
  targetRemote: string;
  /** Which handler fired, e.g. "upload file" or "sync local ➞ remote". */
  operation: string;
}

function tail(s: string): string {
  const trimmed = (s || '').trim();
  return trimmed.length > OUTPUT_TAIL_CHARS
    ? '…' + trimmed.slice(-OUTPUT_TAIL_CHARS)
    : trimmed;
}

/**
 * Resolves when the command exits 0. Rejects on non-zero exit, timeout, or
 * failure to spawn — and the rejection must be allowed to propagate.
 */
export function runBeforeUpload(ctx: BeforeUploadContext): Promise<void> {
  const timeoutMs =
    ctx.timeoutMs && ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_TIMEOUT_MS;

  logger.info(`beforeUpload ➞ running for ${ctx.operation}: ${ctx.command}`);

  return new Promise<void>((resolve, reject) => {
    exec(
      ctx.command,
      {
        cwd: ctx.localBase,
        timeout: timeoutMs,
        windowsHide: true,
        env: Object.assign({}, process.env, {
          SFTP_LOCAL_BASE: ctx.localBase,
          SFTP_REMOTE_PATH: ctx.remotePath,
          SFTP_HOST: ctx.host,
          SFTP_PROFILE: ctx.profile,
          SFTP_TARGET_LOCAL: ctx.targetLocal,
          SFTP_TARGET_REMOTE: ctx.targetRemote,
          SFTP_OPERATION: ctx.operation,
        }),
      },
      (error, stdout, stderr) => {
        const out = tail(stdout);
        const err = tail(stderr);

        if (out) {
          logger.info(`beforeUpload output: ${out}`);
        }

        if (error) {
          if (err) {
            logger.error(`beforeUpload stderr: ${err}`);
          }

          // exec reports a timeout by killing the child; `killed` distinguishes
          // it from an ordinary non-zero exit, and the two need different words
          // because the fixes are different.
          const why = (error as any).killed
            ? `timed out after ${timeoutMs}ms`
            : `exited ${(error as any).code}`;

          const detail = err || out;
          reject(
            new Error(
              `beforeUpload ${why}; transfer aborted. Command: ${ctx.command}` +
                (detail ? `\n${detail}` : '')
            )
          );
          return;
        }

        if (err) {
          // Exit 0 with stderr output is not a failure, but it is worth seeing.
          logger.warn(`beforeUpload stderr (exit 0): ${err}`);
        }

        logger.info('beforeUpload ✓ ok');
        resolve();
      }
    );
  });
}
