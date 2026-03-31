/**
 * @fileoverview Adapter management REST API routes
 *
 * This module provides Express routes for managing external adapter plugins:
 * - Listing all registered adapters (built-in + external)
 * - Installing external adapters from npm packages or local paths
 * - Unregistering external adapters
 *
 * All routes require board-level authentication (assertBoard middleware).
 *
 * @module server/routes/adapters
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import {
  listServerAdapters,
  findServerAdapter,
  listEnabledServerAdapters,
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/registry.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import {
  listAdapterPlugins,
  addAdapterPlugin,
  removeAdapterPlugin,
  getAdapterPluginByType,
  getAdapterPluginsDir,
  getDisabledAdapterTypes,
  setAdapterDisabled,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";
import type { ServerAdapterModule } from "../adapters/types.js";
import { loadExternalAdapterPackage, getUiParserSource } from "../adapters/plugin-loader.js";
import { logger } from "../middleware/logger.js";
import { assertBoard } from "./authz.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Known built-in adapter types (cannot be removed via the API)
// ---------------------------------------------------------------------------

const BUILTIN_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
  "process",
  "http",
]);

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface AdapterInstallRequest {
  /** npm package name (e.g., "droid-paperclip-adapter") or local path */
  packageName: string;
  /** True if packageName is a local filesystem path */
  isLocalPath?: boolean;
  /** Target version for npm packages (optional, defaults to latest) */
  version?: string;
}

interface AdapterInfo {
  type: string;
  label: string;
  source: "builtin" | "external";
  modelsCount: number;
  loaded: boolean;
  disabled: boolean;
  version?: string;
  packageName?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAdapterInfo(adapter: ServerAdapterModule, externalRecord: AdapterPluginRecord | undefined, disabledSet: Set<string>): AdapterInfo {
  return {
    type: adapter.type,
    label: adapter.type, // ServerAdapterModule doesn't have a separate "label" field; type serves as label
    source: externalRecord ? "external" : "builtin",
    modelsCount: (adapter.models ?? []).length,
    loaded: true, // If it's in the registry, it's loaded
    disabled: disabledSet.has(adapter.type),
    version: externalRecord?.version,
    packageName: externalRecord?.packageName,
  };
}

/**
 * Normalize a local path that may be a Windows path into a WSL-compatible path.
 *
 * - Windows paths (e.g., "C:\\Users\\...") are converted via `wslpath -u`.
 * - Paths already starting with `/mnt/` or `/` are returned as-is.
 */
async function normalizeLocalPath(rawPath: string): Promise<string> {
  // Already a POSIX path (WSL or native Linux)
  if (rawPath.startsWith("/")) {
    return rawPath;
  }

  // Windows path detection: C:\ or C:/ pattern
  if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
    try {
      const { stdout } = await execFileAsync("wslpath", ["-u", rawPath]);
      return stdout.trim();
    } catch (err) {
      logger.warn({ err, rawPath }, "wslpath conversion failed; using path as-is");
      return rawPath;
    }
  }

  return rawPath;
}

/**
 * Register an adapter module into the server registry, filling in
 * sessionManagement from the host.
 */
function registerWithSessionManagement(adapter: ServerAdapterModule): void {
  const wrapped: ServerAdapterModule = {
    ...adapter,
    sessionManagement: getAdapterSessionManagement(adapter.type) ?? undefined,
  };
  registerServerAdapter(wrapped);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function adapterRoutes() {
  const router = Router();

  /**
   * GET /api/adapters
   *
   * List all registered adapters (built-in + external).
   * Each entry includes whether the adapter is built-in or external,
   * its model count, and load status.
   */
  router.get("/adapters", async (_req, res) => {
    assertBoard(_req);

    const registeredAdapters = listServerAdapters();
    const externalRecords = new Map(
      listAdapterPlugins().map((r) => [r.type, r]),
    );
    const disabledSet = new Set(getDisabledAdapterTypes());

    const result: AdapterInfo[] = registeredAdapters.map((adapter) =>
      buildAdapterInfo(adapter, externalRecords.get(adapter.type), disabledSet),
    );

    res.json(result);
  });

  /**
   * POST /api/adapters/install
   *
   * Install an external adapter from an npm package or local path.
   *
   * Request body:
   * - packageName: string (required) — npm package name or local path
   * - isLocalPath?: boolean (default false)
   * - version?: string — target version for npm packages
   */
  router.post("/adapters/install", async (req, res) => {
    assertBoard(req);

    const { packageName, isLocalPath = false, version } = req.body as AdapterInstallRequest;

    if (!packageName || typeof packageName !== "string") {
      res.status(400).json({ error: "packageName is required and must be a string." });
      return;
    }

    // Strip version suffix if the UI sends "pkg@1.2.3" instead of separating it
    // e.g. "@henkey/hermes-paperclip-adapter@0.3.0" → packageName + version
    let canonicalName = packageName;
    let explicitVersion = version;
    const versionSuffix = packageName.match(/@(\d+\.\d+\.\d+.*)$/);
    if (versionSuffix) {
      // For scoped packages: "@scope/name@1.2.3" → "@scope/name" + "1.2.3"
      // For unscoped: "name@1.2.3" → "name" + "1.2.3"
      const lastAtIndex = packageName.lastIndexOf("@");
      if (lastAtIndex > 0 && !explicitVersion) {
        canonicalName = packageName.slice(0, lastAtIndex);
        explicitVersion = versionSuffix[1];
      }
    }

    try {
      let installedVersion: string | undefined;
      let moduleLocalPath: string | undefined;

      if (!isLocalPath) {
        // npm install into the managed directory
        const pluginsDir = getAdapterPluginsDir();
        const spec = explicitVersion ? `${canonicalName}@${explicitVersion}` : canonicalName;

        logger.info({ spec, pluginsDir }, "Installing adapter package via npm");

        await execFileAsync("npm", ["install", "--no-save", spec], {
          cwd: pluginsDir,
          timeout: 120_000,
        });

        // Read installed version from package.json
        try {
          const pkgJsonPath = path.join(pluginsDir, "node_modules", canonicalName, "package.json");
          const pkgContent = await import("node:fs/promises");
          const pkgRaw = await pkgContent.readFile(pkgJsonPath, "utf-8");
          const pkg = JSON.parse(pkgRaw);
          installedVersion = pkg.version;
        } catch {
          installedVersion = explicitVersion;
        }
      } else {
        // Local path — normalize (e.g., Windows → WSL) and use the resolved path
        moduleLocalPath = path.resolve(await normalizeLocalPath(packageName));

        // Read version from the local adapter's package.json
        try {
          const pkgContent = await import("node:fs/promises");
          const pkgRaw = await pkgContent.readFile(path.join(moduleLocalPath, "package.json"), "utf-8");
          const pkg = JSON.parse(pkgRaw);
          installedVersion = pkg.version;
        } catch {
          // Local adapter without a readable package.json — no version
        }
      }

      // Load and register the adapter (use canonicalName for path resolution)
      const adapterModule = await loadExternalAdapterPackage(canonicalName, moduleLocalPath);

      // Check if this type conflicts with a built-in adapter
      if (BUILTIN_ADAPTER_TYPES.has(adapterModule.type)) {
        res.status(409).json({
          error: `Adapter type "${adapterModule.type}" is a built-in adapter and cannot be overwritten.`,
        });
        return;
      }

      // Check if already registered (indicates a reinstall/update)
      const existing = findServerAdapter(adapterModule.type);
      const isReinstall = existing !== null;
      if (existing) {
        unregisterServerAdapter(adapterModule.type);
        logger.info({ type: adapterModule.type }, "Unregistered existing adapter for replacement");
      }

      // Register the new adapter
      registerWithSessionManagement(adapterModule);

      // Persist the record (use canonicalName without version suffix)
      const record: AdapterPluginRecord = {
        packageName: canonicalName,
        localPath: moduleLocalPath,
        version: installedVersion ?? explicitVersion,
        type: adapterModule.type,
        installedAt: new Date().toISOString(),
      };
      addAdapterPlugin(record);

      logger.info(
        { type: adapterModule.type, packageName: canonicalName },
        "External adapter installed and registered",
      );

      res.status(201).json({
        type: adapterModule.type,
        packageName: canonicalName,
        version: installedVersion ?? explicitVersion,
        installedAt: record.installedAt,
        requiresRestart: isReinstall,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, packageName }, "Failed to install external adapter");

      // Distinguish npm errors from load errors
      if (message.includes("npm") || message.includes("ERR!")) {
        res.status(500).json({ error: `npm install failed: ${message}` });
      } else {
        res.status(500).json({ error: `Failed to install adapter: ${message}` });
      }
    }
  });

  /**
   * PATCH /api/adapters/:type
   *
   * Enable or disable an adapter. Disabled adapters are hidden from agent
   * creation menus but remain functional for existing agents.
   *
   * Request body: { "disabled": boolean }
   */
  router.patch("/adapters/:type", async (req, res) => {
    assertBoard(req);

    const adapterType = req.params.type;
    const { disabled } = req.body as { disabled?: boolean };

    if (typeof disabled !== "boolean") {
      res.status(400).json({ error: "Request body must include { \"disabled\": true|false }." });
      return;
    }

    // Check that the adapter exists in the registry
    const existing = findServerAdapter(adapterType);
    if (!existing) {
      res.status(404).json({ error: `Adapter "${adapterType}" is not registered.` });
      return;
    }

    const changed = setAdapterDisabled(adapterType, disabled);

    if (changed) {
      logger.info({ type: adapterType, disabled }, "Adapter enabled/disabled");
    }

    res.json({ type: adapterType, disabled, changed });
  });

  /**
   * DELETE /api/adapters/:type
   *
   * Unregister an external adapter. Built-in adapters cannot be removed.
   */
  router.delete("/adapters/:type", async (req, res) => {
    assertBoard(req);

    const adapterType = req.params.type;

    if (!adapterType) {
      res.status(400).json({ error: "Adapter type is required." });
      return;
    }

    // Prevent removal of built-in adapters
    if (BUILTIN_ADAPTER_TYPES.has(adapterType)) {
      res.status(403).json({
        error: `Cannot remove built-in adapter "${adapterType}".`,
      });
      return;
    }

    // Check that the adapter exists in the registry
    const existing = findServerAdapter(adapterType);
    if (!existing) {
      res.status(404).json({
        error: `Adapter "${adapterType}" is not registered.`,
      });
      return;
    }

    // Check that it's an external adapter
    const externalRecord = getAdapterPluginByType(adapterType);
    if (!externalRecord) {
      res.status(404).json({
        error: `Adapter "${adapterType}" is not an externally installed adapter.`,
      });
      return;
    }

    // If installed via npm (has packageName but no localPath), run npm uninstall
    if (externalRecord.packageName && !externalRecord.localPath) {
      try {
        const pluginsDir = getAdapterPluginsDir();
        await execFileAsync("npm", ["uninstall", externalRecord.packageName], {
          cwd: pluginsDir,
          timeout: 60_000,
        });
        logger.info(
          { type: adapterType, packageName: externalRecord.packageName },
          "npm uninstall completed for external adapter",
        );
      } catch (err) {
        logger.warn(
          { err, type: adapterType, packageName: externalRecord.packageName },
          "npm uninstall failed for external adapter; continuing with unregister",
        );
      }
    }

    // Unregister from the runtime registry
    unregisterServerAdapter(adapterType);

    // Remove from the persistent store
    removeAdapterPlugin(adapterType);

    logger.info({ type: adapterType }, "External adapter unregistered and removed");

    res.json({ type: adapterType, removed: true });
  });

  // ── GET /api/adapters/:type/ui-parser.js ─────────────────────────────────
  // Serve the self-contained UI parser JS for an adapter type.
  // This allows external adapters to provide custom run-log parsing
  // without modifying Paperclip's source code.
  //
  // The adapter package must export a "./ui-parser" entry in package.json
  // pointing to a self-contained ESM module with zero runtime dependencies.
  router.get("/:type/ui-parser.js", (req, res) => {
    assertBoard(req);
    const { type } = req.params;
    const source = getUiParserSource(type);
    if (!source) {
      res.status(404).json({ error: `No UI parser available for adapter "${type}".` });
      return;
    }
    res.type("application/javascript").send(source);
  });

  return router;
}
