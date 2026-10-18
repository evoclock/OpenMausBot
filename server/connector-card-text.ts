// For clients that don't know `kind: "connector"` yet (older phones draw `text`), exports and backups. It never carries a
// link: the authorization URL is only ever handed to the person's own client.

/** "Connect GitHub to continue." — or, for a second account, the alias too. */
export function connectorCardText(label: string, alias?: string): string {
  const app = label.replace(/\s+/g, " ").trim() || "this app";
  const account = alias?.replace(/\s+/g, " ").trim();
  return account ? `Connect ${app} as “${account}” to continue.` : `Connect ${app} to continue.`;
}
