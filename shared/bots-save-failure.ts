const HELD_OR_READ_ONLY = new Set(["EPERM", "EACCES", "EBUSY", "EROFS"]);

export function botsSaveFailure(action: string, code: unknown): string {
  const reason = typeof code === "string" && HELD_OR_READ_ONLY.has(code)
    ? "another program is holding OpenMausBot's bots.json, or its folder is read-only"
    : "OpenMausBot couldn't write bots.json";
  return `Couldn't save ${action}: ${reason}.`;
}
