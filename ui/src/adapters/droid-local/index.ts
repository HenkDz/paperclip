import type { UIAdapterModule } from "../types";
import { buildDroidLocalConfig, parseDroidStdoutLine } from "@paperclipai/adapter-droid-local/ui";
import { DroidLocalConfigFields } from "./config-fields";

export const droidLocalUIAdapter: UIAdapterModule = {
  type: "droid_local",
  label: "Droid (local)",
  parseStdoutLine: parseDroidStdoutLine,
  ConfigFields: DroidLocalConfigFields,
  buildAdapterConfig: buildDroidLocalConfig,
};