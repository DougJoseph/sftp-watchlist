# SFTP (watchlist fork)

**A fork of [Natizyskunk/vscode-sftp](https://github.com/Natizyskunk/vscode-sftp) by
[@DougJoseph](https://github.com/DougJoseph), branched from release v1.16.3.** Not published
to the VS Code marketplace — install the `.vsix` from
[Releases](https://github.com/DougJoseph/vscode-sftp/releases).

It adds three things to the upstream extension:

1. **A fix for downloads failing with `isDate is not a function`** on current VS Code — see
   immediately below. This one is likely why you are reading this.
2. **`beforeUpload`** — a shell command run to completion before any local → remote
   transfer, which aborts the transfer if it fails.
3. **A persistent on-disk transfer log**, because the Output panel clears and takes the
   record of what you pushed with it.

Everything else is upstream's, unchanged. The original README follows below the fork
documentation.

---

## Fixed: downloads fail with `TypeError: isDate is not a function`

**Symptom.** Any download or remote → local sync fails. Uploads keep working, which is why
this can go unnoticed for a long time. The stack looks like this:

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

---

## `beforeUpload`

A shell command run to completion **before** any local → remote transfer begins. A non-zero
exit **aborts the transfer**.

```jsonc
{
  "beforeUpload": "./scripts/prepare-upload.sh",
  "beforeUploadTimeout": 120000   // ms; default 120000
}
```

- Runs for `upload`, `upload file`, `upload folder` and `sync local ➞ remote` **only**.
  Downloads and `sync remote ➞ local` never trigger it.
- Runs **once per command**, not once per file — a folder upload recurses below this point.
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

`scripts/prepare-upload.sh`:

```bash
#!/bin/bash
set -euo pipefail

# Whatever has to be true before files leave this machine. Exit non-zero to stop the push.
echo "preparing $SFTP_OPERATION for profile '${SFTP_PROFILE:-none}'"
echo "  local root : $SFTP_LOCAL_BASE"
echo "  target     : $SFTP_TARGET_LOCAL"
echo "  going to   : $SFTP_HOST:$SFTP_REMOTE_PATH"

# e.g. generate a manifest of what is about to be sent
# find "$SFTP_LOCAL_BASE" -type f -print0 | xargs -0 shasum -a 256 > /tmp/manifest.txt

echo "ok"
```

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
- Lines emitted outside an operation — activation, config loading — belong to no project
  and stay panel-only.

**⚠️ Add `/sftp-transfer-logs` to the `ignore` list of every `sftp.json` that uses this.**
The folder sits inside a synced tree, so without that entry it would upload itself.

## Installing this fork

1. Download the `.vsix` from
   [Releases](https://github.com/DougJoseph/vscode-sftp/releases).
2. `code --install-extension sftp-watchlist-<version>.vsix`
3. **Disable the stock SFTP extension** if you have it — both register the same `sftp.*`
   command ids, and having both enabled makes the second one to load fail every
   registration. Disable rather than uninstall, so reverting is one click.
4. Reload the window.

Your existing `sftp.json` files work unchanged: the command ids, menus, keybindings and
config schema are all the same as upstream.

## Building from source

```
git clone https://github.com/DougJoseph/vscode-sftp.git
cd vscode-sftp
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
