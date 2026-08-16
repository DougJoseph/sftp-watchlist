import GitIgnore from 'ignore';

export default class Ignore {
  // FORK ADDITION (DougJoseph, 2026-08-16) — see CHANGELOG "Fork changes".
  //
  // `caseSensitive` selects the matcher's case behaviour, set from a config's
  // `caseSensitivePatterns` key. The `ignore` package defaults to
  // `ignorecase: true`, so upstream matches case-INSENSITIVELY — meaning a
  // pattern aimed at one capitalization silently catches the other, because to
  // the matcher `C3/index.php` and `c3/index.php` are the same path.
  //
  // On a case-insensitive local filesystem syncing to a case-sensitive server,
  // that is exactly the pair a surgical pattern is trying to separate:
  // `C3/index.php` was meant to block a remote capital-C redirect stub on
  // DOWNLOAD while leaving the real lowercase `c3/index.php` free to UPLOAD.
  // Case-insensitively it blocked both — silently, because an ignored path
  // returns before any transfer or error is produced.
  //
  // Scope: this class is the only pattern matcher in the extension, and it has
  // two consumers — the transfer `ignore` list (all directions: upload, sync
  // both ways, download) and `remoteExplorer.filesExclude`. It does NOT change
  // how local and remote filenames are compared to each other during a sync.
  //
  // Default stays FALSE so an unchanged config behaves exactly as upstream.
  static from(pattern, caseSensitive = false) {
    return new Ignore(pattern, caseSensitive);
  }

  pattern: string[] | string;
  private ignore: any;

  constructor(pattern, caseSensitive = false) {
    this.ignore = GitIgnore({ ignorecase: !caseSensitive });
    this.pattern = pattern;
    this.ignore.add(pattern);
  }

  ignores(pathname): boolean {
    if (!GitIgnore.isPathValid(pathname)) {
      return false;
    }

    return this.ignore.ignores(pathname);
  }
}
