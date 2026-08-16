import { Uri } from 'vscode';
import app from '../app';
import { UResource, FileService, ServiceConfig } from '../core';
import logger, { setLogSink } from '../logger';
import { getFileService } from '../modules/serviceManager';
// FORK ADDITIONS (DougJoseph, 2026-08-15) — see CHANGELOG "Fork changes".
import { runBeforeUpload } from '../modules/beforeUpload';
import { createTransferLogSink } from '../modules/transferLog';

interface FileHandlerConfig {
  _?: boolean;
}

export interface FileHandlerContext {
  target: UResource;
  fileService: FileService;
  config: ServiceConfig;
}

type FileHandlerContextMethod<R = void> = (this: FileHandlerContext) => R;
type FileHandlerContextMethodArg1<A, R = void> = (this: FileHandlerContext, a: A) => R;

interface FileHandlerOption<T> {
  name: string;
  handle: FileHandlerContextMethodArg1<T, Promise<any>>;
  afterHandle?: FileHandlerContextMethod;
  config?: FileHandlerConfig;
  transformOption?: FileHandlerContextMethod<T>;
  // FORK ADDITION (DougJoseph, 2026-08-15): true only on handlers that send
  // local files to the remote. Set explicitly rather than inferred from `name`,
  // which is display text and would be a fragile thing to branch on.
  isUpload?: boolean;
}

export function handleCtxFromUri(uri: Uri): FileHandlerContext {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (uri.toString(true) == "file:///${command:sftp.sync.remoteToLocal}") {
      throw '';
    } else {
      throw new Error(`Config Not Found. (${uri.toString(true)})`);
    }
  }
  const config = fileService.getConfig();
  const target = UResource.from(uri, {
    localBasePath: fileService.baseDir,
    remoteBasePath: config.remotePath,
    remoteId: fileService.id,
    remote: {
      host: config.host,
      port: config.port,
    },
  });

  return {
    fileService,
    config,
    target,
  };
}

export function allHandleCtxFromUri(uri: Uri): Array<FileHandlerContext> {
  const fileService = getFileService(uri);
  if (!fileService) {
    if (uri.toString(true) == "file:///${command:sftp.sync.remoteToLocal}") {
      throw '';
    } else {
      throw new Error(`Config Not Found. (${uri.toString(true)})`);
    }
  }

  const configArr = fileService.getAllConfig();

  return configArr.map(config => {
    const target = UResource.from(uri, {
      localBasePath: fileService.baseDir,
      remoteBasePath: config.remotePath,
      remoteId: fileService.id,
      remote: {
        host: config.host,
        port: config.port,
      },
    });

    return {
      fileService,
      config,
      target,
    };
  })
}

export default function createFileHandler<T>(
  handlerOption: FileHandlerOption<T>
): (ctx: FileHandlerContext | Uri, option?: Partial<T>) => Promise<void> {
  async function fileHandle(ctx: Uri | FileHandlerContext, option?: T) {
    const handleCtx = ctx instanceof Uri ? handleCtxFromUri(ctx) : ctx;
    const { target } = handleCtx;

    const invokeOption = handlerOption.transformOption
      ? handlerOption.transformOption.call(handleCtx)
      : {};
    if (option) {
      Object.assign(invokeOption, option);
    }

    if (invokeOption.ignore && invokeOption.ignore(target.localFsPath)) {
      return;
    }

    logger.trace(`handle ${handlerOption.name} for`, target.localFsPath);

    // FORK ADDITION (DougJoseph, 2026-08-15) — see CHANGELOG "Fork changes".
    //
    // This function runs ONCE PER COMMAND, not once per file: a folder upload
    // recurses inside `handle`. That is what makes it the right place for both
    // additions — the hook fires once per push, and the log sink covers every
    // line the whole operation emits.
    const forkConfig = handleCtx.config;
    const forkLocalBase = handleCtx.fileService.baseDir;

    // Point the logger at this config's own transfer log for the duration of
    // the operation, so lines land in the project they belong to.
    const logSink = createTransferLogSink(
      forkLocalBase,
      forkConfig.transferLog,
      forkConfig.transferLogKeepMonths
    );
    setLogSink(logSink);

    try {
      // The hook runs BEFORE the spinner and before any connection is opened,
      // so a rejection here means nothing has been transferred. Deliberately
      // not wrapped in a catch: it must propagate and abort the command.
      if (handlerOption.isUpload && forkConfig.beforeUpload) {
        await runBeforeUpload({
          command: forkConfig.beforeUpload,
          timeoutMs: forkConfig.beforeUploadTimeout,
          localBase: forkLocalBase,
          remotePath: forkConfig.remotePath,
          host: forkConfig.host,
          profile: (forkConfig as any).context || forkConfig.name || '',
          targetLocal: target.localFsPath,
          targetRemote: target.remoteFsPath,
          operation: handlerOption.name,
        });
      }

      app.sftpBarItem.startSpinner();
      try {
        await handlerOption.handle.call(handleCtx, invokeOption);
        // } catch (error) {
        //   reportError(error, `when ${handlerOption.name} ${target.localFsPath}`);
        //   Object.defineProperty(error, 'reported', {
        //     configurable: false,
        //     enumerable: false,
        //     value: true,
        //   });
        //   throw error;
      } finally {
        app.sftpBarItem.stopSpinner();
      }
      if (handlerOption.afterHandle) {
        handlerOption.afterHandle.call(handleCtx);
      }
    } finally {
      // Always released, including on an aborted push, so a later operation in
      // another project can never write into this one's log.
      setLogSink(null);
    }
  }

  return fileHandle;
}
