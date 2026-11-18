# SFTP (watchlist fork)

<p align="center">
  <img src="https://raw.githubusercontent.com/DougJoseph/sftp-watchlist/watchlist/resources/icon.png" width="128" alt="SFTP (watchlist fork)" />
</p>

**A fork of [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp) by
[@DougJoseph](https://github.com/DougJoseph), branched from release v1.16.3.** Published on
the **VS Code Marketplace** as `DougJoseph.sftp-watchlist` — or install the `.vsix` from
[Releases](https://github.com/DougJoseph/sftp-watchlist/releases).

It adds six things to the upstream extension:

1. **Fixes downloads, which are broken in the stock extension.** On current VS Code every
   download and remote → local sync fails there with `isDate is not a function`. Here they
   work, and there is nothing to configure — see immediately below. This is likely why you
   are reading this.
2. **Runs a command of yours before every push, and stops the push if it fails.** It fires
   automatically on every upload and sync, before the first byte leaves, so whatever has to
   accompany a push gets made — a rebuilt manifest, a fresh build — and a push that should
   not happen gets refused outright. `beforeUpload`, optional; leave it out and nothing
   changes.
3. **Keeps an `ignore` pattern from silently blocking a path that differs from it only in
   capitalization.** To the matcher `C3/` and `c3/` are the same path, so a rule meant for
   one quietly stops the other from ever uploading — no transfer, no error.
   `caseSensitivePatterns`, optional, default `false`.
4. **Connects through an intermediary without that intermediary ever holding the
   destination's private key.** For when the destination will not accept your address — or
   you would rather it never saw your address at all. `hopKeysLocal`, optional, default
   `false`.
5. **Writes a permanent record of every transfer.** The Output panel clears and takes the
   history with it; the same lines also go to a monthly file in the project, so "what went
   to that server in August, and when" is still answerable months later.
6. **Keeps the credentials inside `hop` and `profiles` out of the Output panel.** Every time
   a config loads, the extension prints it there with the credentials replaced by `******` —
   but the stock extension only does that at the top level, so a password written inside a
   `hop` entry or a profile is printed in full. Here they are masked at every depth. Nothing
   to configure.

Everything else is upstream's, unchanged. The original README follows below the fork
documentation.

---

## The download fix — the stock extension's `isDate is not a function`

**Symptom.** On the stock extension, any download or remote → local sync fails. Uploads keep
working, which is why this can go unnoticed for a long time. The stack looks like this:

```
TypeError: isDate is not a function
    at attrsToBytes (…/node_modules/ssh2/lib/protocol/SFTP.js:2492:45)
    at SFTP.open (…/node_modules/ssh2/lib/protocol/SFTP.js:331:15)
    at ReadStream.open (…/node_modules/ssh2/lib/protocol/SFTP.js:3706:13)
    at SFTP.createReadStream (…/node_modules/ssh2/lib/protocol/SFTP.js:305:12)
```

**Cause.** `ssh2` 1.13.0 — the version pinned by upstream v1.16.3 — begins `SFTP.js` with:

```js
const { inherits, isDate } = require('util');
```

`util.isDate` was deprecated years ago and has since been **removed** from the Node build
that current VS Code ships. So `isDate` is `undefined`, and calling it throws. The failing
call sits on the read path, which is why uploads are unaffected.

**This affects the stock extension too.** It is not introduced by this fork. Verified by
enabling `Natizyskunk.sftp` 1.16.3 and reproducing the identical error from its own copy of
ssh2 1.13.0, at the same line.

**The fix.** `ssh2` 1.17.0 corrects it upstream —

```js
const { inherits, types: { isDate } } = require('util');
```

— so this fork moves the dependency from `^1.13.0` to `^1.17.0`. No extension code needed
changing. If you would rather stay on the stock extension, bumping ssh2 and rebuilding it
yourself fixes it the same way.

**Nothing to configure.** Installing this fork is the whole fix; there is no setting to turn
on and no change to your `sftp.json`.

---

## `beforeUpload`

Runs a shell command of yours to completion **before** any local → remote transfer begins,
and **aborts the transfer** if that command exits non-zero. Optional: with no `beforeUpload`
set, nothing runs and uploads behave exactly as upstream.

**What it gets you.** The moment before a push is the last chance to get something right, and
the only moment at which stopping costs nothing. Three uses:

- **A list on the server that always matches what was sent.** Where the far end reads a list
  of your files — a checksum manifest, a file-integrity watchlist, a deployment inventory —
  the hook rebuilds that list from the tree being pushed, so the list and the files cannot
  drift apart. If the rebuild fails, the push does not happen.
- **Never a stale build on the server.** The hook runs the build or the bundler, so the
  compiled files that land always came from the source that travelled with them.
- **A push that refuses itself.** The hook inspects the tree and exits non-zero — an `.env`,
  a key, a database dump, a failing test suite — and nothing transfers.

```jsonc
{
  "beforeUpload": "./scripts/prepare-upload.sh",
  "beforeUploadTimeout": 120000   // ms; default 120000
}
```

- Runs for `upload`, `upload file`, `upload folder` and `sync local ➞ remote` **only**.
  Downloads and `sync remote ➞ local` never trigger it.
- Runs **once per command**, not once per file: a folder upload runs the hook once, then
  transfers every file beneath it.
- Runs before any connection is opened, so an abort means nothing was transferred.
- **Fails closed**: a non-zero exit, a timeout, or a failure to spawn all abort the
  transfer and surface the reason. This is deliberate — a hook that failed open would let a
  push proceed without whatever the hook was supposed to produce.
- Working directory is the local root of the config in use.

The command receives these environment variables, so one script can serve several configs:

| Variable | Meaning |
|---|---|
| `SFTP_LOCAL_BASE` | Local root of the config in use |
| `SFTP_REMOTE_PATH` | That config's `remotePath` |
| `SFTP_HOST` | Target host |
| `SFTP_PROFILE` | Profile or context name, blank if the config has none |
| `SFTP_TARGET_LOCAL` | The file or folder acted on, locally |
| `SFTP_TARGET_REMOTE` | Its remote counterpart |
| `SFTP_OPERATION` | Which handler fired, e.g. `upload file` |

### Worked example

**1. Write the script.** Anywhere you like; a relative path in `sftp.json` resolves against
the config's local root, because that is the working directory the command runs in.

`scripts/prepare-upload.sh` — regenerate a checksum manifest of the tree about to be pushed,
so whatever reads it on the far end describes the files that actually went:

```bash
#!/bin/bash
set -euo pipefail

cd "$SFTP_LOCAL_BASE"

find . -type f \
     ! -path './.git/*' \
     ! -path './.vscode/*' \
     ! -path './sftp-transfer-logs/*' \
     ! -name 'manifest.sha256' \
     -print0 \
  | sort -z \
  | xargs -0 shasum -a 256 > manifest.sha256

echo "manifest: $(wc -l < manifest.sha256) files for $SFTP_OPERATION ➞ $SFTP_HOST:$SFTP_REMOTE_PATH"
```

Because the hook runs **before** the transfer, a folder upload or `sync local ➞ remote`
carries the freshly written `manifest.sha256` along with the files it describes. A single-file
upload does not — push the folder when the manifest has to match.

**2. Make it executable.** A script without the executable bit fails to spawn, and because
the hook fails closed that aborts *every* push from this config until it is fixed:

```
chmod +x scripts/prepare-upload.sh
```

**3. Point the config at it**, in that folder's `.vscode/sftp.json`:

```jsonc
{
  "host": "example.com",
  "remotePath": "/var/www/site",
  "beforeUpload": "./scripts/prepare-upload.sh",
  "beforeUploadTimeout": 120000
}
```

**4. Reload the VS Code window.** The extension caches `sftp.json` at load, so an edit does
not take effect until you do.

**5. Confirm it is actually wired**, which takes about a minute:

- Set `"beforeUpload": "echo hello"` and upload any file. The Output panel should show
  `beforeUpload ➞ running …`, then `beforeUpload output: hello`, then `beforeUpload ✓ ok`
  — all **before** the `local ➞ remote` line.
- Then set `"beforeUpload": "exit 3"` and upload again. You should get an error naming
  exit 3, and **no `local ➞ remote` line at all**. That absence is the proof it fails
  closed.
- Reload between each change, then put your real command back.

---

## `caseSensitivePatterns`

```jsonc
{
  "caseSensitivePatterns": true   // default: false (upstream behavior)
}
```

Matches `ignore` and `remoteExplorer.filesExclude` patterns **case-sensitively**. It governs
pattern matching only — the `ignore` list in every direction, plus the Remote Explorer — and
does not change how local and remote filenames are compared during a sync.

**Why it exists.** The matcher is built from the npm
[`ignore`](https://www.npmjs.com/package/ignore) package, which defaults to
`ignorecase: true`, and upstream never overrides it. So to the matcher `C3/index.php` and
`c3/index.php` are the same path, and a pattern written for one capitalization silently
catches the other.

**When you need it.** On a case-insensitive filesystem (macOS, Windows) syncing to a
case-sensitive one (Linux), where the remote holds two paths differing only in case. A
pattern meant to block the remote `C3/index.php` on **download** will also block the real
local `c3/index.php` on **upload**.

**The symptom is silence.** An ignored path returns early, before the progress indicator and
before any connection is opened, so nothing transfers, nothing errors, and the Output panel
shows no `local ➞ remote` line for that file. A file can appear to push for weeks without
ever leaving the machine. If a file you edit never changes on the server and no error
appears, check your `ignore` list for a pattern that differs from it only in case.

Set it to `true` in any config whose `ignore` list contains two patterns differing only by
case. It is per config, so a project with several `sftp.json` files sets it in each one that
needs it.

### Worked example

A remote tree holds both `C3/` and `c3/`. `C3/` is generated on the server and must never be
overwritten from here; `c3/` is yours and has to push. Without the flag the first pattern
silences both:

```jsonc
{
  "host": "example.com",
  "remotePath": "/var/www/site",

  "caseSensitivePatterns": true,

  "ignore": [
    ".git",
    ".vscode",
    "/sftp-transfer-logs",
    "/C3"              // generated on the server — never push over it.
                       // Without caseSensitivePatterns this also silences /c3.
  ]
}
```

Reload the VS Code window, then upload a file inside `c3/` and look for its `local ➞ remote`
line in the Output panel. Its presence is the whole test — before the flag there was no line,
and no error either.

## `hopKeysLocal`

```jsonc
{
  "hopKeysLocal": true   // default: false (upstream behavior)
}
```

Reads every `hop` entry's `privateKeyPath` from **this machine** instead of from the previous
server in the chain. Set it at the top level of the config; one setting covers every hop in
the chain. Configs without it behave exactly as upstream.

### Why hop at all

Hopping — connecting to one machine and going on from there to a second — is upstream's
feature, documented under [Connection Hopping](#connection-hopping) below. You reach for it
when you cannot connect to the destination directly, or when you would rather it never saw
you directly in the first place.

- **It will not accept you.** The destination only accepts connections from an allowlisted or
  static address and yours is neither; it sits on a private network reachable only through a
  bastion; your office or ISP blocks outbound port 22.
- **Keeping your own address clean.** A sync tool is not a person typing `ssh` a few times a
  day. Upload-on-save, a file watcher, a pre-upload hook and scripted pushes open connections
  in volume, and intrusion-prevention software on the far end counts connections and failed
  attempts per source address and then blocks the source. With an intermediary in the path
  the address being counted is the intermediary's — a machine that exists for exactly that
  and can be thrown away and replaced. Your own address never accumulates a reputation with
  the host, because the host never sees it.
- **Getting back in after you have already been blocked.** A block lives at the destination,
  which means you cannot connect in order to lift it. Changing your own address is often not
  practical: a residential connection can hold the same lease for months, a static business
  address is the thing you are paying for, and an office puts everyone behind one address —
  so a block on it stops your colleagues too, and their traffic can get you blocked. A hop
  gets you working again the same day and touches nothing of your own.
- **Not having to ask.** An unblock is a favor, and asking for a second or a third one is how
  an account starts being remembered as a problem. Hopping is a fix entirely on your side of
  the connection: nothing to request, nothing to explain, no goodwill spent.

### What `hopKeysLocal` gets you

It removes the one requirement that makes `hop` unusable for a lot of people: upstream needs
the destination's private key to be sitting on the intermediary.

Upstream reads each hop's `privateKeyPath` from the **previous server in the chain**. So to
reach your destination you must first copy the **destination's own private key onto the
intermediary** — a rented VPS, a cloud instance, a shared company bastion, a machine you may
not own and cannot vouch for. For a lot of setups that is not a trade-off but a wall: policy
forbids it, or you simply will not put the key to your production server on a box like that.

With `hopKeysLocal: true` every key file is read from your own machine. The intermediary
forwards the connection and holds a key to nothing beyond itself. Authentication to the
destination still happens end to end over the forwarded connection, so the intermediary never
sees a credential for the far end.

### Worked example

Local machine ➞ intermediary ➞ destination, with both keys held locally.

**1. Write the config** in `.vscode/sftp.json`. The **top level is the intermediary** and
`hop` is the **destination** — the opposite of how it reads at a glance — and `remotePath`
belongs to the destination:

```jsonc
{
  "name": "site",
  "remotePath": "/var/www/site",        // a path on the DESTINATION

  // the intermediary — the machine the destination will accept
  "host": "jump.example.net",
  "username": "jumpuser",
  "privateKeyPath": "/Users/me/.ssh/id_jump",

  "hopKeysLocal": true,

  "hop": {
    // the destination
    "host": "203.0.113.10",
    "username": "siteuser",
    "privateKeyPath": "/Users/me/.ssh/id_site"   // read from THIS machine
  },

  "uploadOnSave": false
}
```

Two things that bite:

- **Absolute paths only inside `hop`.** `~` is not expanded there, so `~/.ssh/id_site` fails
  to read. This is upstream behavior and the setting does not change it.
- **`hopKeysLocal` goes at the top level, not inside `hop`.** It is read once and applies to
  the whole chain.

**2. Reload the VS Code window.** The extension caches `sftp.json` at load, so an edit does
not take effect until you do.

**3. Upload any file and read the Output panel** (`View > Output`, channel `sftp`). A working
hop logs the forward before the transfer:

```
[info] hopping from jump.example.net to 203.0.113.10
[info] local ➞ remote /Users/me/site/index.php
```

That first line is the proof the connection went the long way round. If the transfer lines
appear without it, the config is being read as a direct connection and your own address is
what the destination is seeing.

**Telling which mode is in force.** With `hopKeysLocal: true`, a wrong or unreadable `hop`
key fails as a local read and the error carries a path on your own machine. Without it, the
same mistake fails on the intermediary instead. That is the quickest way to confirm the
setting is being honored.

### Requires 1.19.0 or later — older builds ignore it silently

Config validation allows unknown keys, so an older build of this fork — or the stock
extension — accepts `hopKeysLocal` without complaint and goes on reading each hop's key from
the previous server. **Nothing warns you.** A config written for this setting then looks for
the destination's key on the intermediary, does not find it, and fails there. If a hop config
fails that way, check the installed version before anything else.

### Multiple hops

`hop` also takes an array, and one `hopKeysLocal` covers every entry in it — every key below
is read locally:

```jsonc
{
  "name": "target",
  "remotePath": "/path/on/target",

  // first intermediary
  "host": "hopA.example.net",
  "username": "hopauser",
  "privateKeyPath": "/Users/me/.ssh/id_hopa",

  "hopKeysLocal": true,

  "hop": [
    // second intermediary
    {
      "host": "hopB.example.net",
      "username": "hopbuser",
      "privateKeyPath": "/Users/me/.ssh/id_hopb"
    },
    // the destination
    {
      "host": "203.0.113.10",
      "username": "targetuser",
      "privateKeyPath": "/Users/me/.ssh/id_target"
    }
  ]
}
```

## The transfer log

Upstream logs only to the VS Code Output panel, which clears — so after a sync there is no
record on disk of what went where. This fork writes the same lines to a monthly file inside
the local folder the running config governs:

```
<config local root>/sftp-transfer-logs/sftp-transfer-YYYY-MM.log
```

```jsonc
{
  "transferLog": true,             // default true; false disables it for this config
  "transferLogKeepMonths": 24      // older monthly files are deleted
}
```

- Monthly files rather than numbered rotation, so "what happened on 15 August" is a
  filename rather than a search.
- Written per config, so each project's transfers land in that project's own log.
- Log lines carry a four-digit year, which the Output panel's own stamp omits.
- Lines emitted outside an operation, such as at activation, belong to no project and stay
  panel-only. A config reloaded while an operation is running is logged during it, so its
  line lands in that operation's file.

**⚠️ Add `/sftp-transfer-logs` to the `ignore` list of every `sftp.json` that uses this.**
The folder sits inside a synced tree, so without that entry it would upload itself.

### Reading the log

The question it answers is *what went to that server, and when* — asked months later, after
the Output panel has been cleared a hundred times. The file holds the panel's own lines, each
stamped with the full year:

```
[2026-10-29 04:23:11] [info] beforeUpload ➞ running for sync local ➞ remote: ./scripts/prepare-upload.sh
[2026-10-29 04:23:12] [info] beforeUpload output: manifest: 318 files for sync local ➞ remote ➞ example.com:/var/www/site
[2026-10-29 04:23:12] [info] beforeUpload ✓ ok
[2026-10-29 04:23:14] [info] local ➞ remote /Users/me/site/index.php
[2026-10-29 04:23:14] [info] local ➞ remote /Users/me/site/css/app.css
```

So "did `index.php` go up on 29 October, and did the hook run before it?" is one command
against one file:

```
grep "2026-10-29" sftp-transfer-logs/sftp-transfer-2026-10.log
```

A failed push is just as readable: the reason is logged in the same place, in order, instead
of being lost with the panel.

## Masked credentials in the printed config — the stock extension stops at the top level

**Symptom.** Each time a config loads — when the window opens, and each time `sftp.json` is
saved — the extension prints the whole config to the Output panel, with `username`,
`password`, `passphrase` and `interactiveAuth` answers replaced by `******`. The stock
extension masks them only at the top level of the config. Inside a `hop` entry, inside each
entry of a `hop` array, and inside a profile, they are printed exactly as written. The stock
extension still works that way.

**A defect from the stock extension, predating this fork.** It is upstream's code, unchanged
since v1.16.3.

**The fix.** This fork masks the same four fields at every depth — a hop inside a hop, a hop
inside a profile, a profile's own fields. Nothing else in the printed line changes: hosts,
ports, paths and key paths still read as written, because that line is often read to check
which key file a config is using.

### Worked example

**1. A config with a password inside its `hop`**, in `.vscode/sftp.json`:

```jsonc
{
  "name": "site",
  "remotePath": "/var/www/site",
  "host": "jump.example.net",
  "username": "jumpuser",
  "privateKeyPath": "/Users/me/.ssh/id_jump",
  "hop": {
    "host": "203.0.113.10",
    "username": "siteuser",
    "password": "s3cret"
  }
}
```

**2. Reload the VS Code window**, then open the Output panel (`View > Output`, channel
`sftp`) and find the line that begins `config at`. On the stock extension it ends (earlier
settings shortened to `…`):

```
[info] config at /Users/me/site {…,"username":"******","privateKeyPath":"/Users/me/.ssh/id_jump","hop":{"host":"203.0.113.10","username":"siteuser","password":"s3cret"}}
```

On this fork, from 1.19.1:

```
[info] config at /Users/me/site {…,"username":"******","privateKeyPath":"/Users/me/.ssh/id_jump","hop":{"host":"203.0.113.10","username":"******","password":"******"}}
```

**3. To confirm it on your own configs**, look at the `hop` part of each `config at` line.
Every `username`, `password` and `passphrase` there reads `******`.

## Installing this fork

1. Download the `.vsix` from
   [Releases](https://github.com/DougJoseph/sftp-watchlist/releases).
2. `code --install-extension sftp-watchlist-<version>.vsix`
3. **Disable the stock SFTP extension** if you have it — both register the same `sftp.*`
   command ids, and having both enabled makes the second one to load fail every
   registration. Disable rather than uninstall, so reverting is one click.
4. Reload the window.

Your existing `sftp.json` files work unchanged: the command ids, menus, keybindings and
config schema are all the same as upstream.

## Building from source

```
git clone https://github.com/DougJoseph/sftp-watchlist.git
cd sftp-watchlist
git checkout watchlist
npm install
npm run compile
npx @vscode/vsce package
```

Two things worth knowing before you start:

- **Branch from the release tag, not `develop`.** Upstream's `develop` does not compile —
  it has a missing import in `src/commands/abstract/createCommand.ts` and a `vscode-uri`
  export mismatch in `src/helper/paths.ts`. This fork branches from tag `v1.16.3`, which
  builds clean.
- The `package` script calls the legacy `vsce`, which is not a dependency here. Use
  `npx @vscode/vsce package` as above.

---

# sftp sync extension for VS Code

Maintained and updated version by [@Natizyskunk](https://github.com/Natizyskunk/) 😀 <br>
(Forked from the no longer maintained [liximomo's SFTP plugin](https://github.com/liximomo/vscode-sftp.git))

- VS Code marketplace : https://marketplace.visualstudio.com/items?itemName=Natizyskunk.sftp <br>
- VSIX release : https://github.com/Natizyskunk/vscode-sftp/releases/

---

VSCode-SFTP enables you to add, edit or delete files within a local directory and have it sync to a remote server directory using different transfer protocols like FTP or SSH. The most basic setup requires only a few lines of configuration with a wide array of specific settings also available to meet the needs of any user. Both powerful and fast, it helps developers save time by allowing the use of a familiar editor and environment.

- Features
  - [Browser remote with Remote Explorer](#remote-explorer)
  - Diff local and remote
  - Sync directory
  - Upload/Download
  - Upload on save
  - File Watcher
  - Multiple configurations
  - Switchable profiles
  - Temp File support
- [Commands](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)
- [Debug](#debug)
- [FAQ](#FAQ)

## Installation

### Method 1 (Recommended : Auto update)
1. Select Extensions (Ctrl + Shift + X).
2. Uninstall current sftp extension from @liximomo.
3. Install new extension directly from VS Code Marketplace : https://marketplace.visualstudio.com/items?itemName=Natizyskunk.sftp.
4. Voilà!

### Method 2 (Manual update)
To install just follow these steps from within VSCode:
1. Select Extensions (Ctrl + Shift + X).
2. Uninstall current sftp extension from @liximomo.
3. Open "More Action" menu(ellipsis on the top) and click "Install from VSIX…".
4. Locate VSIX file and select.
5. Reload VSCode.
6. Voilà!

## Documentation
- [Home](https://github.com/Natizyskunk/vscode-sftp/wiki)
- [Settings](https://github.com/Natizyskunk/vscode-sftp/wiki/Setting)
- [Common configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/Common-Configuration)
- [SFTP configuration](https://github.com/Natizyskunk/vscode-sftp/wiki/SFTP-only-Configuration)
- [FTP confriguration](https://github.com/Natizyskunk/vscode-sftp/wiki/FTP(s)-only-Configuration)
- [Commands](https://github.com/Natizyskunk/vscode-sftp/wiki/Commands)

## Usage
If the latest files are already on a remote server, you can start with an empty local folder,
then download your project, and from that point sync.

1. In `VS Code`, open a local directory you wish to sync to the remote server (or create an empty directory
that you wish to first download the contents of a remote server folder in order to edit locally).
2. `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on Mac open command palette, run `SFTP: config` command.
3. A basic configuration file will appear named `sftp.json` under the `.vscode` directory, open and edit the configuration parameters with your remote server information.

For instance:
```json
{
    "name": "Profile Name",
    "host": "name_of_remote_host",
    "protocol": "ftp",
    "port": 21,
    "secure": true,
    "username": "username",
    "remotePath": "/public_html/project", // <--- This is the path which will be downloaded if you "Download Project"
    "password": "password",
    "uploadOnSave": false
}
```
The password parameter in `sftp.json` is optional, if left out you will be prompted for a password on sync.
_Note：_ backslashes and other special characters must be escaped with a backslash.

4. Save and close the `sftp.json` file.
5. `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on Mac open command palette.
6. Type `sftp` and you'll now see a number of other commands. You can also access many of the commands from the project's file explorer context menus.
7. A good one to start with if you want to sync with a remote folder is `SFTP: Download Project`.  This will download the directory shown in the `remotePath` setting in `sftp.json` to your local open directory.
8. Done - you can now edit locally and after each save it will upload to sync your remote file with the local copy.
9. Enjoy!

For detailed explanations please go to [wiki](https://github.com/Natizyskunk/vscode-sftp/wiki).

## Example configurations
You can see the full list of configuration options [here](https://github.com/Natizyskunk/vscode-sftp/wiki/configuration).

- [sftp sync extension for VS Code](#sftp-sync-extension-for-vs-code)
  - [Installation](#installation)
    - [Method 1 (Recommended : Auto update)](#method-1-recommended--auto-update)
    - [Method 2 (Manual update)](#method-2-manual-update)
  - [Documentation](#documentation)
  - [Usage](#usage)
  - [Example configurations](#example-configurations)
    - [Simple](#simple)
    - [Profiles](#profiles)
    - [Multiple Context](#multiple-context)
    - [Connection Hopping](#connection-hopping)
      - [Single Hop](#single-hop)
      - [Multiple Hop](#multiple-hop)
    - [Configuration in User Setting](#configuration-in-user-setting)
  - [Remote Explorer](#remote-explorer)
    - [Multiple Select](#multiple-select)
    - [Order](#order)
  - [Debug](#debug)
  - [FAQ](#faq)
  - [Donation](#donation)
    - [Buy Me a Coffee](#buy-me-a-coffee)
    - [PayPal](#paypal)

### Simple
```json
{
  "host": "host",
  "username": "username",
  "remotePath": "/remote/workspace"
}
```

### Profiles
```json
{
  "username": "username",
  "password": "password",
  "remotePath": "/remote/workspace/a",
  "watcher": {
    "files": "dist/*.{js,css}",
    "autoUpload": false,
    "autoDelete": false
  },
  "profiles": {
    "dev": {
      "host": "dev-host",
      "remotePath": "/dev",
      "uploadOnSave": true
    },
    "prod": {
      "host": "prod-host",
      "remotePath": "/prod"
    }
  },
  "defaultProfile": "dev"
}
```

_Note：_ `context` and `watcher` are only available at root level.

Use `SFTP: Set Profile` to switch profile.

### Multiple Context
The context must **not be same**.
```json
[
  {
    "name": "server1",
    "context": "project/build",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/project/build"
  },
  {
    "name": "server2",
    "context": "project/src",
    "host": "host",
    "username": "username",
    "password": "password",
    "remotePath": "/remote/project/src"
  }
]
```

_Note：_ `name` is required in this mode.

### Connection Hopping
You can connect to a target server through a proxy with ssh protocol.

_Note：_ Variable substitution is not working in a hop configuration.

#### Single Hop
local -> hop -> target
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // hop
  "host": "hopHost",
  "username": "hopUsername",
  "privateKeyPath": "/Users/localUser/.ssh/id_rsa", // <-- The key file is assumed on the local.

  "hop": {
    // target
    "host": "targetHost",
    "username": "targetUsername",
    "privateKeyPath": "/Users/hopUser/.ssh/id_rsa", // <-- The key file is assumed on the hop.
  }
}
```

#### Multiple Hop
local -> hopa -> hopb -> target
```json
{
  "name": "target",
  "remotePath": "/path/in/target",

  // hopa
  "host": "hopAHost",
  "username": "hopAUsername",
  "privateKeyPath": "/Users/hopAUsername/.ssh/id_rsa" // <-- The key file is assumed on the local.

  "hop": [
    // hopb
    {
      "host": "hopBHost",
      "username": "hopBUsername",
      "privateKeyPath": "/Users/hopaUser/.ssh/id_rsa" // <-- The key file is assumed on the hopa.
    },

    // target
    {
      "host": "targetHost",
      "username": "targetUsername",
      "privateKeyPath": "/Users/hopbUser/.ssh/id_rsa", // <-- The key file is assumed on the hopb.
    }
  ]
}
```

### Configuration in User Setting
You can use `remote` to tell sftp to get the configuration from [remote-fs](https://github.com/liximomo/vscode-remote-fs).

In User Setting:
```json
"remotefs.remote": {
  "dev": {
    "scheme": "sftp",
    "host": "host",
    "username": "username",
    "rootPath": "/path/to/somewhere"
  },
  "projectX": {
    "scheme": "sftp",
    "host": "host",
    "username": "username",
    "privateKeyPath": "/Users/xx/.ssh/id_rsa",
    "rootPath": "/home/foo/some/projectx"
  }
}
```

In sftp.json:
```json
{
  "remote": "dev",
  "remotePath": "/home/xx/",
  "uploadOnSave": false,
  "ignore": [".vscode", ".git", ".DS_Store"]
}
```

## Remote Explorer
![remote-explorer-preview](https://raw.githubusercontent.com/Natizyskunk/vscode-sftp/master/assets/showcase/remote-explorer.png)

Remote Explorer lets you explore files in remote. You can open Remote Explorer by:

1. Run Command `View: Show SFTP`.
2. Click SFTP view in Activity Bar.

You can only view a files content with Remote Explorer. Run command `SFTP: Edit in Local` to edit it in local.

### Multiple Select
You are able to select multiple files/folders at once on the remote server to download and upload. You can do it simply by holding down Ctrl or Shift while selecting all desired files, just like on the regular explorer view.

_Note：_ You need to manually refresh the parent folder after you **delete** a file if the explorer isn't correctly updated.

### Order
You can order the remote Explorer by adding the `remoteExplorer.order` parameter inside your `sftp.json` config file.

In sftp.json:
```json
{
  "remoteExplorer": {
    "order": 1 // <-- Default value is 0.
  }
}
```

## Debug
1. Open User Settings.
  - On Windows/Linux - `File > Preferences > Settings`
  - On macOS - `Code > Preferences > Settings`
2. Set `sftp.debug` to `true` and reload vscode.
3. View the logs in `View > Output > sftp`.

## FAQ
You can see all the Frequently Asked Questions [here](./FAQ.md).

## Donation
If this project helped you reduce development time and you wish to contribute financially

### Buy Me a Coffee
[![Buy Me A Coffee](https://bmc-cdn.nyc3.digitaloceanspaces.com/BMC-button-images/custom_images/orange_img.png)](https://www.buymeacoffee.com/Natizyskunk)

### PayPal
<!-- [![PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif)](https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=BY89QD47D7MPS&source=url) -->
[![PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate?business=DELD7APHHM3BC&no_recurring=0&currency_code=EUR)
[![PayPal Me](https://img.shields.io/badge/Donate-PayPal-green.svg)](https://paypal.me/natanfourie)
