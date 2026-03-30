/**
 * @fileoverview Frontend API client for external adapter management.
 */

import { api } from "./client";

export interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  /** Installed version (for external npm adapters) */
  version?: string;
  /** Package name (for external adapters) */
  packageName?: string;
}

export interface AdapterInstallResult {
  type: string;
  packageName: string;
  version?: string;
  installedAt: string;
}

export const adaptersApi = {
  /** List all registered adapters (built-in + external). */
  list: () => api.get<AdapterInfo[]>("/adapters"),

  /** Install an external adapter from npm or a local path. */
  install: (params: { packageName: string; version?: string; isLocalPath?: boolean }) =>
    api.post<AdapterInstallResult>("/adapters/install", params),

  /** Remove an external adapter by type. */
  remove: (type: string) => api.delete<{ type: string; removed: boolean }>(`/adapters/${type}`),

  /** Enable or disable an adapter (disabled adapters hidden from agent menus). */
  setDisabled: (type: string, disabled: boolean) =>
    api.patch<{ type: string; disabled: boolean; changed: boolean }>(`/adapters/${type}`, { disabled }),
};
