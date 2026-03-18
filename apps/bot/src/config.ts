import { loadConfig as loadCoreConfig, type AppConfig } from "@kirbot/core";

export type { AppConfig };

export function loadConfig(): AppConfig {
  return loadCoreConfig();
}
