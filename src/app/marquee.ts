/**
 * The score's selection rectangle (PLAN.md §11.3 revision 7 "Score selection"), canvas CSS px.
 * canvas-input writes it during a background drag; the dots overlay draws it each frame, so no
 * React render sits on the pointer path.
 */

export const marquee = { on: false, x0: 0, y0: 0, x1: 0, y1: 0 };
