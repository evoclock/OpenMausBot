/** On Windows titleBarStyle "hidden" without titleBarOverlay removes the caption buttons too, so the renderer draws them:
 * the WCO overlay API cannot style hover. */
export function windowChromeOptions(platform) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 16 } };
  }
  if (platform === "win32") {
    return { titleBarStyle: "hidden" };
  }
  return {};
}
