// The splash can be destroyed mid-boot: during startup an empty window set means boot is still working, not quit.
export function createAllWindowsClosedQuit({ app, platform = process.platform, allWindows }) {
  let startupSettled = false;
  const maybeQuit = () => {
    if (platform === "darwin" || !startupSettled) return;
    if (allWindows().length > 0) return;
    app.quit();
  };
  app.on("window-all-closed", maybeQuit);
  return {
    // window-all-closed does not repeat for an already-empty set, so the drained check runs here too.
    settleStartup: () => {
      startupSettled = true;
      maybeQuit();
    },
  };
}
