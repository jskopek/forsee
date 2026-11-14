import { expect, it } from 'vitest';
import { PLUGIN_HOST_PACKAGE } from './index';

it('exports its package name', () => {
  expect(PLUGIN_HOST_PACKAGE).toBe('@forsee/plugin-host');
});
