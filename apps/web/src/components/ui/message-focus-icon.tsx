/**
 * Lucide icon geometry, ISC License.
 * Copyright (c) 2026 Lucide Icons and Contributors
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */
import { createLucideIcon } from 'lucide-react';

// Lucide Maximize2 geometry (ISC, lucide-react). Keep the existing Lucide
// defaults/context/accessibility, but use two stroked paths for this icon which
// occurs once per message. Each subpath starts with an absolute move: the
// original separate paths' leading relative moves were relative to (0, 0).
// Combine only disjoint strokes, retaining the original paint order at each
// crossing. Chromium raster rounding at scaled sizes is covered by the pixel
// comparison test; the actual 13px icon is identical at 1x and 2x.
export const MessageFocusIcon = createLucideIcon('maximize-2', [
  ['path', { d: 'M15 3h6v6 M3 21l7-7', key: 'first' }],
  ['path', { d: 'M21 3l-7 7 M9 21H3v-6', key: 'second' }],
]);
