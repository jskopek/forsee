import type { CommandArgs } from '@forsee/plugin-api';
import { expect, expectTypeOf, it } from 'vitest';
import { LAYOUT_SCHEMA_VERSION, LAYOUTS_PACKAGE } from './index';

it('exports its package name and the schema version', () => {
  expect(LAYOUTS_PACKAGE).toBe('@forsee/layouts');
  expect(LAYOUT_SCHEMA_VERSION).toBe(1);
});

it('adds the layout commands to the typed command map', () => {
  expectTypeOf<CommandArgs<'layout.showPage'>>().toEqualTypeOf<{ readonly page: string }>();
  expectTypeOf<CommandArgs<'layout.back'>>().toEqualTypeOf<undefined>();
});
