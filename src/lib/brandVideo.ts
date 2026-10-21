/* Brand banner videos (Batch 29 Part 6): the still preview picture that
   shows while a video loads. (Batch 40: videos are no longer downloaded
   ahead of time — only when a brand page's banner is on screen.) */

/**
 * The still preview of a brand video: its first frame, saved next to the
 * video in Storage under a derived name (the video's path + ".poster.jpg"),
 * so no database column is needed. It exists for videos uploaded from Batch
 * 29 on, and for older ones once Admin → Brands → "Create missing video
 * previews" has been tapped.
 */
export function videoPosterUrl(videoUrl: string): string {
  const q = videoUrl.indexOf('?');
  return q === -1 ? `${videoUrl}.poster.jpg` : `${videoUrl.slice(0, q)}.poster.jpg${videoUrl.slice(q)}`;
}
