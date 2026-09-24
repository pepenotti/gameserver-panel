/**
 * Project Zomboid, config files: the server ini, SandboxVars.lua and the
 * spawn files, their schemas, managed keys and presets (CFG-01…10).
 */
import type { OptionMeta, PanelAdapterConfig } from '@gsp/adapter-api';
import { todo } from '../../shared/todo';
import metaJson from './option-meta.json';

/** Settings metadata generated from the game's own files (scripts/gen-option-meta.ts). */
export const PZ_OPTION_META = metaJson as { source: string; ini: OptionMeta[]; sandbox: OptionMeta[] };

// ---- TODO(M1-C) -------------------------------------------------------------
// Port from packages/panel/src/config/service.ts (file paths, MANAGED_INI,
// SECRET_INI, RESTART_ONLY_INI, FIRST_RUN_INI, reloadoptions and its log
// warnings, sandbox presets) and declare the editable folders, then drop the
// `todo()` calls. Nothing calls them yet.
export const pzPanelConfig: PanelAdapterConfig = {
  files: () => todo('M1-C', 'config.files'),
  roots: () => todo('M1-C', 'config.roots'),
  schemas: { ini: PZ_OPTION_META.ini, sandbox: PZ_OPTION_META.sandbox },
  managedValues: () => todo('M1-C', 'config.managedValues'),
  afterWrite: () => todo('M1-C', 'config.afterWrite'),
  presets: {
    list: () => todo('M1-C', 'config.presets.list'),
    load: () => todo('M1-C', 'config.presets.load'),
  },
};
// ---- end TODO(M1-C) ---------------------------------------------------------
