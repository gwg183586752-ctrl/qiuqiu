import type { AppConfig } from '../config.ts';
import type { CloudAdapters } from './types.ts';
import { createFakeCloud } from './fake.ts';
import { createMimoCloud } from './mimo.ts';

export function createCloud(config: AppConfig): CloudAdapters {
  return config.cloudMode === 'fake' ? createFakeCloud() : createMimoCloud(config);
}
