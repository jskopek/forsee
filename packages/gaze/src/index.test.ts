import type { GazeControl } from '@forsee/core';
import { expect, expectTypeOf, it } from 'vitest';
import { GAZE_PACKAGE, type GazePipeline } from './index';

it('exports its package name', () => {
  expect(GAZE_PACKAGE).toBe('@forsee/gaze');
});

it('the pipeline can be injected into the kernel as its gaze control', () => {
  expectTypeOf<GazePipeline>().toExtend<GazeControl>();
});
