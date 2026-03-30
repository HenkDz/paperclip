/**
 * External adapter plugin loader.
 *
 * Loads external adapter packages from the adapter-plugin-store and returns
 * their ServerAdapterModule instances. The caller (registry.ts) is
 * responsible for registering them.
 *
 * This avoids circular initialization: plugin-loader imports only
 * adapter-utils, never registry.ts.
 *
 * Loading mechanism:
 * - Reads ~/.paperclip/adapter-plugins.json at startup
 * - Dynamically imports each stored adapter package
 * - The package root must export `createServerAdapter()` → ServerAdapterModule
 *
 * To add a new external adapter:
 * - Use the POST /api/adapters/install REST endpoint
 * - Or manually add an entry to ~/.paperclip/adapter-plugins.json
 *
 * Adapter package convention:
 * The package root must export a `createServerAdapter()` function that
 * returns a `ServerAdapterModule`. The loader resolves the entry point
 * from package.json exports["."] > main > index.js.
 */

import fs from "node:fs";
import path from "node:path";
import type { ServerAdapterModule } from "./types.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Adapter-plugin-store integration
// ---------------------------------------------------------------------------

import {
  listAdapterPlugins,
  getAdapterPluginsDir,
} from "../services/adapter-plugin-store.js";
import type { AdapterPluginRecord } from "../services/adapter-plugin-store.js";

// Track which types come from the store
const storeLoadedTypes = new Set<string>();

/**
 * In-memory cache of UI parser JS sources extracted from adapter packages.
 * Keyed by adapter type. Populated at load time by loadExternalAdapterPackage().
 */
const uiParserCache = new Map<string, string>();

/**
 * Get the UI parser JS source for an adapter type (if available).
 * Returns undefined if the adapter doesn't provide a UI parser.
 */
export function getUiParserSource(adapterType: string): string | undefined {
  return uiParserCache.get(adapterType);
}

/**
 * Dynamically load an external adapter package.
 *
 * For npm packages: resolves from the managed adapter-plugins directory.
 * For local paths: resolves from the provided absolute path.
 *
 * The package must export `createServerAdapter()` which returns a
 * ServerAdapterModule.
 *
 * Throws on failure — callers that need startup tolerance should catch.
 */
export async function loadExternalAdapterPackage(
  packageName: string,
  localPath?: string,
): Promise<ServerAdapterModule> {
  let packageDir: string;

  if (localPath) {
    packageDir = path.resolve(localPath);
  } else {
    const pluginsDir = getAdapterPluginsDir();
    packageDir = path.resolve(pluginsDir, "node_modules", packageName);
  }

  // Resolve the package's main entry by reading package.json
  const pkgJsonPath = path.join(packageDir, "package.json");
  const pkgRaw = fs.readFileSync(pkgJsonPath, "utf-8");
  const pkg = JSON.parse(pkgRaw);

  let entryPoint: string;
  if (pkg.exports && typeof pkg.exports === "object" && pkg.exports["."]) {
    const exp = pkg.exports["."];
    entryPoint = typeof exp === "string" ? exp : (exp.import ?? exp.default ?? "index.js");
  } else if (pkg.main) {
    entryPoint = pkg.main;
  } else {
    entryPoint = "index.js";
  }

  const modulePath = path.resolve(packageDir, entryPoint);

  // ── Extract UI parser source (if adapter provides one) ─────────────────
  // Adapters can export a self-contained UI parser via package.json
  // exports["./ui-parser"]. This is served to the Paperclip UI for
  // dynamic loading, so external adapters get custom run-log parsing
  // without modifying Paperclip's source code.
  //
  // Contract version is checked via paperclip.adapterUiParser in package.json.
  // Only version "1.x" is currently supported.
  const SUPPORTED_PARSER_CONTRACT = "1";
  let uiParserSource: string | undefined;
  if (pkg.exports && typeof pkg.exports === "object" && pkg.exports["./ui-parser"]) {
    // Validate contract version
    const contractVersion = pkg.paperclip?.adapterUiParser;
    if (contractVersion) {
      const major = contractVersion.split(".")[0];
      if (major !== SUPPORTED_PARSER_CONTRACT) {
        logger.warn(
          { packageName, contractVersion, supported: `${SUPPORTED_PARSER_CONTRACT}.x` },
          "Adapter declares unsupported UI parser contract version — skipping UI parser",
        );
      } else {
        const uiParserExp = pkg.exports["./ui-parser"];
        const uiParserFile = typeof uiParserExp === "string"
          ? uiParserExp
          : (uiParserExp.import ?? uiParserExp.default);
        const uiParserPath = path.resolve(packageDir, uiParserFile);
        // Path containment: ensure the resolved path stays within the package directory
        if (!uiParserPath.startsWith(packageDir + path.sep) && uiParserPath !== packageDir) {
          logger.warn(
            { packageName, uiParserFile },
            "UI parser path escapes package directory — skipping",
          );
        } else if (fs.existsSync(uiParserPath)) {
          try {
            uiParserSource = fs.readFileSync(uiParserPath, "utf-8");
            logger.info({ packageName, uiParserFile, size: uiParserSource.length }, "Loaded UI parser from adapter package");
          } catch (err) {
            logger.warn({ err, packageName, uiParserFile }, "Failed to read UI parser from adapter package");
          }
        }
      }
    } else {
      logger.info(
        { packageName },
        "Adapter has ./ui-parser export but no paperclip.adapterUiParser version — loading anyway (future versions may require it)",
      );
      const uiParserExp = pkg.exports["./ui-parser"];
      const uiParserFile = typeof uiParserExp === "string"
        ? uiParserExp
        : (uiParserExp.import ?? uiParserExp.default);
      const uiParserPath = path.resolve(packageDir, uiParserFile);
      if (!uiParserPath.startsWith(packageDir + path.sep) && uiParserPath !== packageDir) {
        logger.warn(
          { packageName, uiParserFile },
          "UI parser path escapes package directory — skipping",
        );
      } else if (fs.existsSync(uiParserPath)) {
        try {
          uiParserSource = fs.readFileSync(uiParserPath, "utf-8");
          logger.info({ packageName, uiParserFile, size: uiParserSource.length }, "Loaded UI parser from adapter package (no version declared)");
        } catch (err) {
          logger.warn({ err, packageName, uiParserFile }, "Failed to read UI parser from adapter package");
        }
      }
    }
  }

  logger.info({ packageName, packageDir, entryPoint, modulePath, hasUiParser: !!uiParserSource }, "Loading external adapter package");

  const mod = await import(modulePath);
  const createServerAdapter = mod.createServerAdapter;

  if (typeof createServerAdapter !== "function") {
    throw new Error(
      `Package "${packageName}" does not export createServerAdapter(). ` +
      `Ensure the package's main entry exports a createServerAdapter function.`,
    );
  }

  const adapterModule = createServerAdapter() as ServerAdapterModule;

  if (!adapterModule || !adapterModule.type) {
    throw new Error(
      `createServerAdapter() from "${packageName}" returned an invalid module (missing "type").`,
    );
  }

  // Cache the UI parser source (if extracted above) keyed by adapter type
  if (uiParserSource) {
    uiParserCache.set(adapterModule.type, uiParserSource);
  }

  return adapterModule;
}

/**
 * Dynamically load a single adapter from its store record.
 * Returns null on failure for startup tolerance.
 */
async function loadFromRecord(record: AdapterPluginRecord): Promise<ServerAdapterModule | null> {
  try {
    const adapter = await loadExternalAdapterPackage(
      record.packageName,
      record.localPath,
    );
    storeLoadedTypes.add(adapter.type);
    return adapter;
  } catch (err) {
    logger.warn(
      { err, packageName: record.packageName, type: record.type },
      "Failed to dynamically load external adapter; skipping",
    );
    return null;
  }
}

/**
 * Build all external adapter modules from the plugin store.
 *
 * Reads ~/.paperclip/adapter-plugins.json and dynamically imports each entry.
 * The caller must attach sessionManagement (via getAdapterSessionManagement)
 * and register each adapter with the mutable registry.
 */
export async function buildExternalAdapters(): Promise<ServerAdapterModule[]> {
  const results: ServerAdapterModule[] = [];

  const storeRecords = listAdapterPlugins();
  for (const record of storeRecords) {
    const adapter = await loadFromRecord(record);
    if (adapter) {
      results.push(adapter);
    }
  }

  if (results.length > 0) {
    logger.info(
      { count: results.length, adapters: results.map((a) => a.type) },
      "Loaded external adapters from plugin store",
    );
  }

  return results;
}

/**
 * Check whether a given adapter type was loaded from the plugin store.
 */
export function isStoreLoadedAdapter(type: string): boolean {
  return storeLoadedTypes.has(type);
}
