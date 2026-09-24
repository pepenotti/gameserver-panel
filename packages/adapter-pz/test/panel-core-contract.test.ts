import { panelAdapterCoreSuite } from '@gsp/adapter-api/testing/panel-suite-core';
import { pzPanelAdapter } from '../src/panel';

panelAdapterCoreSuite(pzPanelAdapter, {
  server: () => ({ id: 'test', gameName: 'zomboid', flavour: null }),
  secrets: () => ({ adminPassword: 'Admin-pw-123456' }),
});
