// Wires Files into the desktop app: the service with Electron's pieces, and its channels for this computer's own window
// only. A folder reaches `share` only as a token for one the person picked (or the app suggested and checked) here.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createCloudFilesService } from "./cloud-sync.mjs";
import { createDownloadMarker } from "./cloud-sync-mark.mjs";

const TOKEN_MS = 30 * 60_000;

/** `stateDir`: Files' own folder under userData; the staging Admin keeps its own (cloud-account.mjs cloudTarget). */
export function installCloudFiles({ app, ipcMain, dialog, shell, powerMonitor, fetch, localWorkspaceOnly, send, cloudOrigin, cloudAccount, localDataDir, now = Date.now, stateDir = "cloud-sync" }) {
  const dir = path.join(app.getPath("userData"), stateDir);
  const service = createCloudFilesService({
    settingsFile: path.join(dir, "settings.json"), stateFile: path.join(dir, "state.db"),
    documentsDir: app.getPath("documents"), homeDir: app.getPath("home"), localDataDir, cloudOrigin, fetch,
    trashItem: (file) => shell.trashItem(file), markDownloaded: createDownloadMarker(),
    onChange: (state) => send("files:state-changed", state),
  });
  const tokens = new Map();
  const issue = (checked) => {
    for (const [token, entry] of tokens) if (entry.at + TOKEN_MS < now()) tokens.delete(token);
    const token = randomUUID();
    if (!checked.refusal) tokens.set(token, { pcPath: checked.pcPath, at: now() });
    return { token, ...checked };
  };
  const pick = async () => {
    const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0];
  };
  const handle = (channel, work) => ipcMain.handle(channel, localWorkspaceOnly(channel, work));
  handle("files:state", () => service.state());
  handle("files:pick", async () => {
    const picked = await pick();
    return picked ? issue(await service.check(picked)) : null;
  });
  handle("files:check", async (_event, paths) => {
    if (!Array.isArray(paths) || paths.length > 20 || !paths.every((value) => typeof value === "string" && value.length <= 4096)) throw new Error("Invalid folders.");
    return Promise.all(paths.map(async (value) => issue(await service.check(value))));
  });
  handle("files:share", async (_event, token) => {
    const entry = typeof token === "string" ? tokens.get(token) : null;
    if (!entry) throw new Error("Choose the folder again.");
    tokens.delete(token);
    return service.share(entry.pcPath);
  });
  const folderId = (value) => {
    if (typeof value !== "string" || !/^[\w-]{1,200}$/.test(value)) throw new Error("Invalid folder.");
    return value;
  };
  handle("files:stop", (_event, id) => service.stopSharing(folderId(id)));
  handle("files:deletes", (_event, id, remove) => service.answerDeletes(folderId(id), remove === true));
  handle("files:locate", async (_event, id) => {
    const picked = await pick();
    return picked ? service.relocate(folderId(id), picked) : service.state();
  });
  handle("files:outputs", (_event, enabled) => service.setOutputs(enabled === true));
  handle("files:open", async (_event, target) => {
    const folder = service.localFolder(target?.outputs === true ? { outputs: true } : { folderId: folderId(target?.folderId) });
    if (folder) await shell.openPath(folder);
  });
  handle("files:more-space", async () => { await cloudAccount().openDashboard(); });
  powerMonitor.on("resume", () => service.wake());
  return { start: () => service.start(), close: () => service.close() };
}
