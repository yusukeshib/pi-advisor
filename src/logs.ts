import { constants } from "node:fs";
import { mkdir, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join, parse, resolve } from "node:path";

// Logging redaction is deliberately separate from the request: it does not alter advice inputs.
export function redact(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const [key, value] of Object.entries(env)) {
    if (
      /(key|token|secret|password|credential)/i.test(key) &&
      value &&
      value.length >= 8
    )
      text = text.split(value).join("[REDACTED]");
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
async function privateDirectory(directory: string) {
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split("/")
    .filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Unsafe log path");
  }
  const stat = await lstat(absolute);
  if ((stat.mode & 0o077) !== 0)
    throw new Error("Log directory must be private (0700)");
}
export async function writeLog(
  directory: string,
  id: string,
  record: object,
  completed: boolean,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid log ID");
  await privateDirectory(directory);
  const pending = join(directory, `${id}.pending.json`);
  const temporary = completed
    ? join(directory, `${id}.finalizing.json`)
    : pending;
  let applied = false;
  const cleaned = JSON.stringify(record, (_key, value: unknown) => {
    if (typeof value !== "string") return value;
    const safe = redact(value);
    applied ||= safe !== value;
    return safe;
  });
  const payload = JSON.stringify(
    {
      ...JSON.parse(cleaned),
      redaction: {
        applied,
        policy:
          "environment credentials and common bearer/key patterns; not guaranteed secret-free",
      },
    },
    null,
    2,
  );
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(payload);
  } finally {
    await file.close();
  }
  if (completed) {
    await rename(temporary, join(directory, `${id}.completed.json`));
    await unlink(pending).catch(() => {});
    await retain(directory);
  }
}
export async function retain(directory: string, now = Date.now()) {
  const records = [];
  for (const name of await readdir(directory)) {
    if (!/^[0-9a-f-]{36}\.completed\.json$/.test(name)) continue;
    const path = join(directory, name);
    const stat = await lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink())
      records.push({ path, time: stat.mtimeMs, size: stat.size });
  }
  records.sort((a, b) => a.time - b.time);
  let total = records.reduce((sum, record) => sum + record.size, 0);
  for (const record of records) {
    if (record.time < now - 30 * 86400000 || total > 100 * 1024 * 1024) {
      await unlink(record.path);
      total -= record.size;
    }
  }
}
