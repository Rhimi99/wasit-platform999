/**
 * Marketing video duration policy — the single source of truth shared by the
 * API, the renderer and the studio UI.
 *
 * WASIT requires every generated marketing video to run between 35 and 120
 * seconds inclusive. The bounds are business rules, not provider limits: the
 * bundled structural renderer (ffmpeg/libass) has no intrinsic duration
 * ceiling and renders the full 35–120 range in a single pass. Keeping the
 * numbers here means a UI control and a server guard can never drift apart.
 */
export const MARKETING_VIDEO_MIN_DURATION_SECONDS = 35;
export const MARKETING_VIDEO_MAX_DURATION_SECONDS = 120;
export const MARKETING_VIDEO_DEFAULT_DURATION_SECONDS = 60;

export const MARKETING_VIDEO_DURATION = {
  min: MARKETING_VIDEO_MIN_DURATION_SECONDS,
  max: MARKETING_VIDEO_MAX_DURATION_SECONDS,
  default: MARKETING_VIDEO_DEFAULT_DURATION_SECONDS,
} as const;

/** True when `value` is a whole number of seconds inside the WASIT window. */
export function isMarketingVideoDuration(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MARKETING_VIDEO_MIN_DURATION_SECONDS &&
    value <= MARKETING_VIDEO_MAX_DURATION_SECONDS
  );
}
