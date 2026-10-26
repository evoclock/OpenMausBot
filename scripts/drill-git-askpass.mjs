#!/usr/bin/env node
if (/Username/i.test(process.argv[2] ?? "")) {
  process.stdout.write("x-access-token\n");
} else if (/Password/i.test(process.argv[2] ?? "") && process.env.OMB_ASKPASS_URL) {
  const url = new URL(process.env.OMB_ASKPASS_URL);
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") process.exit(1);
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) process.exit(1);
  process.stdout.write(`${await response.text()}\n`);
} else process.exit(1);
