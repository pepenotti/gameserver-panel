import type { PanelAdapter } from '@gsp/adapter-api';
import { PZ_META } from '../shared/meta';
import { pzPanelConfig } from './config';
import { pzPanelCore, type PzLaunchSettings } from './core';

export type { PzLaunchSettings };

/** The Project Zomboid panel adapter: the core half (M1-B) plus the config half (M1-C). */
export const pzPanelAdapter: PanelAdapter<PzLaunchSettings> = {
  meta: PZ_META,
  ...pzPanelCore,
  config: pzPanelConfig,
};
