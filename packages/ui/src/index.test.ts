import type { Kernel } from '@forsee/core';
import type { ActivationOutcome } from '@forsee/gaze';
import type { ActivateEvent, ForseeApi } from '@forsee/plugin-api';
import { expect, expectTypeOf, it } from 'vitest';
import {
  UI_PACKAGE,
  type ActivationAdapter,
  type ActivationAdapterResult,
  type GazeTargetProps,
  type HostUiServices,
  type PanelComponentProps,
} from './index';

it('exports its package name', () => {
  expect(UI_PACKAGE).toBe('@forsee/ui');
});

it('activation callbacks receive the full ActivateEvent', () => {
  expectTypeOf<NonNullable<GazeTargetProps['onActivate']>>()
    .parameter(0)
    .toEqualTypeOf<ActivateEvent>();
  expectTypeOf<ActivationAdapter['handle']>().parameters.toEqualTypeOf<
    [ActivateEvent, ActivationOutcome]
  >();
  expectTypeOf<ReturnType<ActivationAdapter['handle']>>().toEqualTypeOf<
    Promise<ActivationAdapterResult>
  >();
});

it('only host infrastructure gets the kernel; feature panels get ForseeApi', () => {
  expectTypeOf<HostUiServices['kernel']>().toEqualTypeOf<Kernel>();
  expectTypeOf<PanelComponentProps['api']>().toEqualTypeOf<ForseeApi>();
  expectTypeOf<PanelComponentProps>().not.toHaveProperty('services');
  expectTypeOf<PanelComponentProps>().not.toHaveProperty('kernel');
});
