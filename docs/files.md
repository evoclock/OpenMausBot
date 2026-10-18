# Files: share folders with My Cloud, get your bots' work

Files is a top-level page in the desktop app, for people with a MausBot Cloud ("My Cloud"). It does two jobs, and both go one way only:

- **Shared with My Cloud.** Folders the person picks are copied from this computer to My Cloud and kept up to date. Bots on My Cloud can read them, even while the computer is off.
- **Your bots' work.** What Cloud bots make comes down to `Documents/MausBot/<bot>/<conversation>` on this computer.

It never merges two sides. The person's files on this computer are never changed by a bot, and nothing on this computer is deleted because of something that happened on My Cloud.

## What the person does

- **Add a folder.** The folder picker opens. The app checks the folder, then asks: "Share “Clients” with My Cloud? 1,240 files · 3.2 GB." Choose **Share** or **Cancel**.
- **Stop sharing**, from the ⋯ menu. My Cloud's copy moves to its trash for 30 days. Nothing on this computer changes.
- **After a move to My Cloud**, the folders that stayed on this computer are offered: **Share them with My Cloud**.
- **The bots' work switch.** It is on by default. Only conversations active since the switch was turned on come down, so old history doesn't flood Documents.

## Shared folders (this computer → My Cloud)

`electron/cloud-sync-plan.mjs` `planShare`, `electron/cloud-sync-engine.mjs` `shareFolder`.

- **The computer decides what is shared.** The desktop keeps its own list (`settings.json` `shared`) and syncs only folders it registered itself. A folder My Cloud lists for this computer is never read or written on that basis.
- **Folders that are never shared:**
  - the home folder or anything above it;
  - a drive root or a mount point;
  - MausBot's own folders: its data folder and `Documents/MausBot`;
  - folders of keys and settings: `.ssh`, `.aws`, `.gnupg`, `.config`, `Library`, `AppData` and similar;
  - a folder inside, or around, one already shared.
- **This computer's version always wins.** A file new or changed here is uploaded. If a bot edits the copy anyway, the next pass puts this computer's version back, and the bot's version stays in My Cloud's trash. Files a bot adds to the copy stay on My Cloud and never come down.
- **On My Cloud, the copy is read-only** (files `0444`). The bots' prompt names the shared folders, says the copies are read-only, and tells bots to save their own work in their own folder.
- **Deletes:**
  - A file gone from this computer is removed from My Cloud, into its trash, only when the base proves it was there.
  - If 10 or more files go at once and they are at least a fifth of the folder, or the folder is now empty, the folder waits: "{n} files were removed from this folder here. Remove them from My Cloud too?" The person chooses **Remove from My Cloud** or **Keep them**.
  - A folder that is gone from this computer (moved, renamed, a drive unplugged) is "missing". Nothing changes on My Cloud, and the person chooses **Find it** (the picker) or **Stop sharing**.
  - A file that is still being written, a link, a hard-linked file, or anything under a linked folder is "kept": it is not carried, and it never reads as deleted.
- **Full.** My Cloud always keeps max(2 GB, 15% of its disk) free (`cloudReserveBytes`). Files that don't fit wait, smallest first, and Files shows **Get more space**. The disk never grows by itself.

## Bots' work (My Cloud → this computer)

`planOutputs`, `fetchOutputs`.

- **What comes down:** each bot conversation folder (`task-workspaces/<bot>/<thread>`) that changed since the switch was turned on (`newestMs`). It lands in `Documents/MausBot/<bot name>/<conversation title>`, with names made safe for Windows and macOS.
- **Never deleted here.** A file removed on My Cloud stays on this computer. A file the person removed here comes back only when My Cloud has a newer version.
- **The person's edit is kept.** When the file here changed since it came down, My Cloud's newer version lands beside it, as "report (new from My Cloud, 15 Oct 2026).md". A file that was not edited is replaced, and the old copy goes to the Recycle Bin first.
- **Never brought down:**
  - an agent's or a tool's config: `.mcp.json`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.claude/`, `.codex/`, `.cursor/`, `.vscode/`, `.idea/`, `.github/`, `.envrc`, `*.code-workspace`, matched case-insensitively;
  - anything sync skips, such as `.git` and `node_modules`;
  - a name with a direction override character;
  - on Windows, a name Windows can't hold.
- **Every download** is checked against its sha256, then marked as downloaded from the internet, the way a browser marks a download: Mark of the Web on Windows, the quarantine flag on macOS.

## On My Cloud

`server/cloud-sync.ts`, `server/routes/cloud-sync.ts`.

- **Access.** `/api/sync/*` answers only on a Cloud home, and only to the owner's admin session.
- **Where things live:**
  - Shared copies are under `/data/Synced/<computer>/<folder>`, outside the data folder, so workspace backups and Move to Cloud don't carry them.
  - Sync's own records (`sync/`) are left out of backups.
- **Changes.** Nothing watches the disk. When a bot's turn ends, `index.ts` tells the sync service (`noteSyncBotTurn`), which wakes the desktop's long poll for that conversation's folder. The desktop also runs a full pass every 5 minutes.
- **Downloads** are served with `content-disposition: attachment`, `nosniff`, and `content-security-policy: sandbox`.

## The desktop's channels

The calls are listed in `electron/cloud-sync.d.mts` (`CloudFilesBridge`).

- **Who can call them.** The channels answer this computer's own window only (`localWorkspaceOnly`). The My Cloud page gets no Files bridge.
- **How a folder is shared.** A folder reaches `share` only as a token for one the person picked in the native dialog, or one the app suggested and checked. A token is used once, and expires after 30 minutes.

## Not in v1
- Two-way folders, where a bot edits the person's files in place.
- Phones.
- Connecting OneDrive, Google Drive or Dropbox to My Cloud. That's probably the better route for documents already in those services.
