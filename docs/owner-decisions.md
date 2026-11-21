# Owner decisions (kept by the integrator)

The owner is away from 2026-11-21. Technical calls are the integrator's ("no backend stuff, I trust you fully"). This file lists the product, sound and UX questions held for the owner, and the product-visible calls the integrator made, which the owner may veto. The newest entries go at the top of each section.

## Needs you
- **Pluck and organ attack (M4.5-32).** The arrival-tick fix gives every attack a smooth curve of at least 12 ms. Glass's attack goes from 4 to 12 ms, organ's from 3 to 12 ms and pluck's from 2 to 12 ms, so pluck is softer and organ loses its key-click. The other option is to apply the floor only to gentle strikes (≤ ~50 %, such as glass) and keep pluck and organ crisp. To check, set "All notes" to pluck, then organ, in the Notes drawer.
- **Arrival tick (M4.5-32).** Listen to whether the tick when all notes land after a transition is gone. The examples all use glass.
- **Starting key.** The piece's own key (`piece.key`) has no control. A key moment at 0:00 does the same job. Do you want a Key control in piece settings, or should it come with M4.5-27 ("the start is a moment")?

## Decided by the integrator (veto if wrong)
- **Space (M4.5-37).** Space plays and pauses everywhere except while typing in a text field. Space held during a drag still pans. The degree picker's chips use Enter instead of Space.
- **Drag preview and auditioning (M4.5-35).**
  - Auditions play only while the transport is stopped; during playback the edit is heard live anyway.
  - Selecting a moment plays its target notes once.
  - Picks in the inspector play the result once, for about 1.5 s.
  - A dragged note sounds at each snapped pitch.
  - Hover previews are visual only.
- **Key carry-forward (M4.5-36).**
  - "Carry it forward" is read as: a key change offers to move the fixed notes up to the next key change, and later key moments are not shifted.
  - Fixed notes are remapped by scale degree. The tonic moves the shorter way, with ties going down.
  - Suggestions are written relative to the key.
- **Weights (M4.5-29b).**
  - Line width is √weight: 1.5 px at weight 1, 3 px at 4, 4.2 px at 8. There is no "×n" mark, because next to the Hz label it read as several notes.
  - MIDI velocity is √weight, scaled down evenly when the loudest note would pass 127.
  - Changing a weight doesn't freeze the chord.
  - The wobble effect is gone. The "wobble" preset stays, without the beating.
- **Distinct notes (M4.5-29a).**
  - Two lines may briefly share a note only while one of them is already leaving (within 10 s).
  - A new line bound for its parent's note is not born; its weight joins that line.
  - Free octaves for a chord come from the lines' own range, so they can fall outside the chord's register.
  - Explicit merges pass their loudness on.
- **Shift-drag octaves (M4.5-33).**
  - Alt now means "free": chromatic pitch and time off the grid.
  - Shift-pressing an unselected dot adds it to the selection, so the octave drag moves the selection plus that dot.
- **Spread (M4.5-30).** A new warning, `spread-crowded`, appears when a range is too narrow to keep the notes apart.
- **Shift slider (M4.5-31).**
  - The slider runs ±2 octaves and snaps to the octave marks within 0.75 of a step.
  - The value shows as "+7". The octave form, "+1 oct", appears only in the tooltip, so the track doesn't jump while you drag.
- **Normalisation.** Overall loudness still counts silent voices, a call by the rev 9 session. Making it level-aware would undo fades.
