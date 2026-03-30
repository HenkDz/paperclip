/**
 * JSON-file-backed store for external adapter registrations.
 *
 * Stores metadata about externally installed adapter packages at
 * ~/.paperclip/adapter-plugins.json. This is the source of truth for which
 * external adapters should be loaded at startup.
 *
 * @module server/services/adapter-plugin-store
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdapterPluginRecord {
  /** npm package name (e.g., "droid-paperclip-adapter") */
  packageName: string;
  /** Absolute local filesystem path (for locally linked adapters) */
  localPath?: string;
  /** Installed version string (for npm packages) */
  version?: string;
  /** Adapter type identifier (matches ServerAdapterModule.type) */
  type: string;
  /** ISO 8601 timestamp of when the adapter was installed */
  installedAt: string;
  /** Whether this adapter is disabled (hidden from menus but still functional) */
  disabled?: boolean;
  /**
   * UI parser JS source — a self-contained ESM module that exports
   * `parseStdoutLine(line: string, ts: string): TranscriptEntry[]`.
   *
   * Populated at load time from the adapter package's `exports["./ui-parser"]`
   * entry point (if present). Served to the Paperclip UI for dynamic loading
   * so external adapters can provide custom run-log parsing without modifying
   * Paperclip's source code.
   */
  uiParserSource?: string;
}

/**
 * Adapter settings store — tracks which adapter types are disabled.
 *
 * Stored at ~/.paperclip/adapter-settings.json alongside the plugin store.
 * Disabling an adapter hides it from agent creation menus and adapter lists,
 * but the adapter remains registered and functional for existing agents.
 */
interface AdapterSettings {
  /** Set of adapter type identifiers that are currently disabled. */
  disabledTypes: string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const PAPERCLIP_DIR = path.join(os.homedir(), ".paperclip");
const ADAPTER_PLUGINS_DIR = path.join(PAPERCLIP_DIR, "adapter-plugins");
const ADAPTER_PLUGINS_STORE_PATH = path.join(PAPERCLIP_DIR, "adapter-plugins.json");
const ADAPTER_SETTINGS_PATH = path.join(PAPERCLIP_DIR, "adapter-settings.json");

// ---------------------------------------------------------------------------
// Store functions
// ---------------------------------------------------------------------------

/**
 * Ensure the ~/.paperclip/adapter-plugins directory exists and contains
 * a package.json so npm install doesn't traverse upward to find a root.
 */
function ensureDirs(): void {
  fs.mkdirSync(ADAPTER_PLUGINS_DIR, { recursive: true });
  const pkgJsonPath = path.join(ADAPTER_PLUGINS_DIR, "package.json");
  if (!fs.existsSync(pkgJsonPath)) {
    fs.writeFileSync(pkgJsonPath, JSON.stringify({
      name: "paperclip-adapter-plugins",
      version: "0.0.0",
      private: true,
      description: "Managed directory for Paperclip external adapter plugins. Do not edit manually.",
    }, null, 2) + "\n");
  }
}

/**
 * Read the full store from disk. Returns an empty array if the file does not
 * exist or is corrupt.
 */
function readStore(): AdapterPluginRecord[] {
  try {
    const raw = fs.readFileSync(ADAPTER_PLUGINS_STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as AdapterPluginRecord[];
  } catch {
    return [];
  }
}

/**
 * Persist the full store to disk.
 */
function writeStore(records: AdapterPluginRecord[]): void {
  ensureDirs();
  fs.writeFileSync(ADAPTER_PLUGINS_STORE_PATH, JSON.stringify(records, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all externally registered adapter plugins.
 */
export function listAdapterPlugins(): AdapterPluginRecord[] {
  return readStore();
}

/**
 * Add a new external adapter registration. If a record with the same `type`
 * already exists it is replaced.
 */
export function addAdapterPlugin(record: AdapterPluginRecord): void {
  const store = readStore();
  const idx = store.findIndex((r) => r.type === record.type);
  if (idx >= 0) {
    store[idx] = record;
  } else {
    store.push(record);
  }
  writeStore(store);
}

/**
 * Remove an external adapter registration by type.
 * Returns `true` if a record was removed, `false` otherwise.
 */
export function removeAdapterPlugin(type: string): boolean {
  const store = readStore();
  const idx = store.findIndex((r) => r.type === type);
  if (idx < 0) return false;
  store.splice(idx, 1);
  writeStore(store);
  return true;
}

/**
 * Look up a single external adapter registration by type.
 */
export function getAdapterPluginByType(type: string): AdapterPluginRecord | undefined {
  return readStore().find((r) => r.type === type);
}

/**
 * Get the managed directory where npm adapter packages are installed.
 * The directory is created if it does not exist.
 */
export function getAdapterPluginsDir(): string {
  ensureDirs();
  return ADAPTER_PLUGINS_DIR;
}

// ---------------------------------------------------------------------------
// Adapter enable/disable (settings)
// ---------------------------------------------------------------------------

function readSettings(): AdapterSettings {
  try {
    const raw = fs.readFileSync(ADAPTER_SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.disabledTypes)) {
      return parsed as AdapterSettings;
    }
    return { disabledTypes: [] };
  } catch {
    return { disabledTypes: [] };
  }
}

function writeSettings(settings: AdapterSettings): void {
  ensureDirs();
  fs.writeFileSync(ADAPTER_SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

/**
 * Get all disabled adapter type identifiers.
 */
export function getDisabledAdapterTypes(): string[] {
  return readSettings().disabledTypes;
}

/**
 * Check whether a specific adapter type is disabled.
 */
export function isAdapterDisabled(type: string): boolean {
  return readSettings().disabledTypes.includes(type);
}

/**
 * Set the disabled/enabled state for an adapter type.
 * Returns `true` if the state was changed, `false` if it was already in the desired state.
 */
export function setAdapterDisabled(type: string, disabled: boolean): boolean {
  const settings = readSettings();
  const idx = settings.disabledTypes.indexOf(type);

  if (disabled && idx < 0) {
    settings.disabledTypes.push(type);
    writeSettings(settings);
    return true;
  }
  if (!disabled && idx >= 0) {
    settings.disabledTypes.splice(idx, 1);
    writeSettings(settings);
    return true;
  }
  return false;
}
