import { expect, it } from 'vitest';
import { PLUGIN_API_PACKAGE } from './index';

it('exports its package name', () => {
  expect(PLUGIN_API_PACKAGE).toBe('@forsee/plugin-api');
});
