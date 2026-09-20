import { env } from '../env.js';
import { LocalMediaStorage } from './local-storage.js';
import type { MediaStorage } from './port.js';
import { NoopVideoProvider, StructuralVideoProvider } from './video-provider.js';
import type { VideoGenerationProvider } from './video-types.js';

/**
 * Resolves the configured media storage driver. `MEDIA_STORAGE` selects the
 * backend; unknown values fall back to the local driver (assets stay inside
 * the deployment boundary rather than leaking to an unconfigured vendor).
 */
export function resolveMediaStorage(): MediaStorage {
  switch (env.MEDIA_STORAGE) {
    case 'local':
    default:
      return new LocalMediaStorage();
  }
}

/**
 * Resolves the configured video generation provider. `noop` is a harness that
 * always fails generation loudly; it is never selected without being explicit.
 */
export function resolveVideoProvider(): VideoGenerationProvider {
  switch (env.VIDEO_PROVIDER) {
    case 'noop':
      return new NoopVideoProvider();
    case 'structural':
    default:
      return new StructuralVideoProvider();
  }
}

/** Describes the media/video configuration for health + admin surfaces. */
export async function describeMediaProviders(): Promise<{
  storage: { id: string; available: boolean };
  video: { id: string; available: boolean; reason: string | null; async: boolean };
}> {
  const storage = resolveMediaStorage();
  const video = resolveVideoProvider();
  return {
    storage: { id: storage.id, available: await storage.isAvailable() },
    video: {
      id: video.id,
      available: await video.isAvailable(),
      reason: video.unavailableReason(),
      async: video.isAsync,
    },
  };
}