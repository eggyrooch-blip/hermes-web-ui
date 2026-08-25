import { computed, type CSSProperties } from 'vue'

/**
 * The label transition for collapsing / expanding the rail.
 *
 * Labels used to be `collapsed ? null : <span>` — mounted and unmounted
 * outright, so there was no intermediate state to transition. The text
 * appeared with a snap inside a still-64px-wide box while the width was
 * mid-animation; that is where the abruptness came from. They are now
 * always rendered and cross-fade with a small offset.
 *
 * The two directions are deliberately asymmetric:
 *
 *   expanding — width goes first (300ms), the text fades in 140ms later,
 *               so the letters only appear once the box has settled
 *   collapsing — the text fades out immediately (no delay), and the width
 *               closes after, so the text is gone before it is squeezed
 *
 * Using one duration for both makes the text stretch with the box on the
 * way out and get crushed on the way in.
 */
export function useLabelFade(collapsed: () => boolean) {
  return computed<CSSProperties>(() => {
    const isCollapsed = collapsed()
    const delay = isCollapsed ? '0ms' : '140ms'
    return {
      // Collapsed, flex must go to 0 — a zero-width `flex:1` child still
      // claims the remaining space and pushes sibling icons off-center.
      flex: isCollapsed ? '0 0 0px' : 1,
      minWidth: 0,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      // `overflow: hidden` obliges an ellipsis. Without it a long task name is
      // cut hard through the middle of a glyph — a flush right edge that reads
      // as a rendering fault; the ellipsis is what says "there is more".
      // Rows carrying a pulse dot and a hover action button are down to ~150px,
      // so they are the first to be clipped.
      textOverflow: 'ellipsis',
      opacity: isCollapsed ? 0 : 1,
      transform: isCollapsed ? 'translateX(-6px)' : 'none',
      transition:
        `opacity 200ms var(--ease-out) ${delay}, ` +
        `transform 240ms var(--ease-out) ${delay}`,
    }
  })
}
