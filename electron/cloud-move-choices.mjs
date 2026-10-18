// What this desktop remembers about copies: servers whose offer the person dismissed, and the Cloud its bots were
// copied to, so This computer can say they live there now.
import { jsonFile } from "./desktop-prefs.mjs";

const strings = value => Array.isArray(value) ? value.filter(entry => typeof entry === "string") : [];

export function cloudMoveChoices(file, files) {
  const store = jsonFile(file, files);
  const read = () => {
    try { const value = store.read(); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; }
  };
  return {
    dismissed: origin => strings(read().dismissed).includes(origin),
    dismiss(origin) {
      const saved = read();
      if (origin && !strings(saved.dismissed).includes(origin)) store.write({ ...saved, dismissed: [...strings(saved.dismissed), origin].slice(-20) });
    },
    /** Set by a copy to the Cloud, cleared by swapping it back. */
    movedHome: origin => typeof origin === "string" && read().home === origin,
    setHome(origin) {
      const { home: _home, ...saved } = read();
      store.write(typeof origin === "string" ? { ...saved, home: origin } : saved);
    },
  };
}
