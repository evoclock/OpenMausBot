// The whole app as a new Cloud's owner sees it (scripts/verify-cloud-welcome.ts answers the session as one).
// ?desktop=1 adds the reduced bridge a Cloud's page gets in the desktop app, with this computer's work to copy;
// ?copy=uploading|done shows a copy under way or landed; ?cloud=full a Cloud with bots of its own; ?step= opens the
// welcome on a step; ?skin= picks a skin.
import { createRoot } from "react-dom/client";
import type { CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";
import App from "../../src/App";
import { returnToWelcome } from "../../src/lib/cloud-welcome";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { applySkin, type SkinId } from "../../src/lib/skins";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const GB = 1024 ** 3;

function installCloudPage(copy: string | null) {
  const destination = { id: "cloud", name: params.get("name") ?? "My Cloud", origin: location.origin, kind: "cloud" as const };
  const local = { bots: 6, rooms: 2, chats: 142, bytes: 1.2 * GB, files: 1800, routines: 4 };
  const state: CloudMoveState = copy === "uploading"
    ? { phase: "uploading", action: "move", destination, progress: { bytesTransferred: 0.54 * GB, totalBytes: 1.2 * GB } }
    : copy === "done" ? { phase: "done", action: "move", destination, moved: { bots: 6, rooms: 2, chats: 142 }, routines: 4 } : { phase: "idle" };
  const overview: CloudMoveOverview = {
    ...state, local, suggest: true, destination, blocked: null,
    cloud: params.get("cloud") === "full"
      ? { contents: { bots: 6, rooms: 2, chats: 142 }, empty: false, freeBytes: 14 * GB, previous: null, heldBytes: 0 }
      : { contents: { bots: 1, rooms: 0, chats: 0 }, empty: true, freeBytes: 18 * GB, previous: null, heldBytes: 0 },
    fit: { fit: "now", neededBytes: 3.9 * GB, freeBytes: 18 * GB },
  };
  window.ogb = {
    platform: "darwin",
    getCapabilities: async () => initialDesktopCapabilities(),
    onCapabilitiesChanged: () => () => {},
    workspaces: { state: async () => ({ local: false, name: destination.name, origin: location.origin }), menu: async () => {} },
    cloudMove: {
      state: async () => overview, start: async () => state, cancel: async () => state, restorePrevious: async () => state,
      dismiss: async () => ({ ...overview, phase: "idle" }), onState: () => () => {},
    },
    cloudLending: { open: async () => {} },
    cloudPlan: {
      state: async () => ({ status: "paid", tier: "pro", credit: { grantedUsd: 5, remainingUsd: 5, state: "active" } }),
      manage: async () => {}, useThisComputer: async () => {},
    },
  } as unknown as typeof window.ogb;
}

if (params.get("desktop") === "1") installCloudPage(params.get("copy"));
applySkin((params.get("skin") ?? "midnight") as SkinId);
const step = params.get("step");
if (step) returnToWelcome(step);
createRoot(document.getElementById("root")!).render(<App />);
