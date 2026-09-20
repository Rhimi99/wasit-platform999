/**
 * Video generation port — the only surface the media service depends on when it
 * needs a marketing video rendered.
 *
 * The port is deliberately provider-agnostic: a local structural renderer (the
 * default, and a real MP4 renderer) and, later, an external generative-video
 * vendor both implement it. No vendor SDK may be imported by callers; a new
 * provider is registered in `resolve.ts`, exactly like the payments/AI ports.
 */

/** Everything the renderer needs, derived from live WASIT product data. */
export interface RenderSpec {
  productId: string;
  /** Product display name in the requested language (may fall back to base name). */
  productName: string;
  description: string;
  brand?: string | null;
  price?: string | null;
  currencyCode: string;
  sellerName?: string | null;
  imageUrl?: string | null;
  language: 'ar' | 'fr' | 'en' | 'zh';
  audience: 'B2B' | 'B2C';
  style: 'MODERN' | 'MINIMAL' | 'BOLD' | 'ELEGANT';
  durationSeconds: number;
}

export interface RenderedVideo {
  bytes: Buffer;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  durationSeconds: number;
  /** Provider-side asset id when the vendor generates asynchronously. */
  externalRef?: string;
  provider: string;
  /** True when the renderer simply could not run (no framework/network). */
  degraded?: boolean;
}

export interface VideoGenerationProvider {
  readonly id: string;
  /** True when this renderer can produce a video right now. */
  isAvailable(): Promise<boolean>;
  /** Human-readable reason the renderer is unavailable (never contains secrets). */
  unavailableReason(): string | null;
  render(spec: RenderSpec): Promise<RenderedVideo>;
  /**
   * True for generative vendors that return a job id and finish later. The
   * local structural renderer is synchronous and returns `false`.
   */
  readonly isAsync: boolean;
}