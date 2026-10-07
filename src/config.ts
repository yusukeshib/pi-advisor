import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface Config {
  model: string;
  reasoning: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  timeoutMs: number;
  maxInputChars: number;
  logDirectory: string;
}
export function qualifiedModel(value: unknown): value is string {
  return typeof value === "string" && /^[^/\s]+\/[^\s]+$/.test(value);
}
export function defaults(): Config {
  return {
    model: "openai-codex/gpt-6.1-sol",
    reasoning: "high",
    maxTokens: 4096,
    timeoutMs: 120000,
    maxInputChars: 48000,
    logDirectory: join(
      process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
      "pi-advisor/consultations",
    ),
  };
}
export async function loadConfig(agentDir: string): Promise<Config> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(agentDir, "pi-advisor.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults();
    throw new Error("Invalid pi-advisor.json");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Config must be an object");
  const values = raw as Record<string, unknown>;
  const config = defaults();
  for (const key of Object.keys(values))
    if (!Object.hasOwn(config, key)) throw new Error("Unknown config key");
  Object.assign(config, values);
  if (!qualifiedModel(config.model))
    throw new Error("Model must be provider/model");
  if (
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      config.reasoning,
    )
  )
    throw new Error("Invalid reasoning");
  for (const [key, min, max] of [
    ["maxTokens", 1, 32768],
    ["timeoutMs", 1, 300000],
    ["maxInputChars", 1000, 100000],
  ] as const) {
    if (
      !Number.isInteger(config[key]) ||
      config[key] < min ||
      config[key] > max
    )
      throw new Error(`Invalid ${key}`);
  }
  if (
    typeof config.logDirectory !== "string" ||
    !isAbsolute(config.logDirectory)
  )
    throw new Error("logDirectory must be absolute");
  return config;
}
