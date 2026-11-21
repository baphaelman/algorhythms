# Owner decisions (kept by the integrator)

The owner is away from 2026-11-21. Technical calls are the integrator's ("no backend stuff, I trust you fully"). This file lists the product, sound and UX questions held for the owner, and the product-visible calls the integrator made, which the owner may veto. The newest entries go at the top of each section.

## Needs you
- **Pluck and organ attack (M4.5-32).** The arrival-tick fix gives every attack a smooth curve of at least 12 ms. Glass's attack goes from 4 to 12 ms, organ's from 3 to 12 ms and pluck's from 2 to 12 ms, so pluck is softer and organ loses its key-click. The other option is to apply the floor only to gentle strikes (≤ ~50 %, such as glass) and keep pluck and organ crisp. To check, set "All notes" to pluck, then organ, in the Notes drawer.
- **Arrival tick (M4.5-32).** Listen to whether the tick when all notes land after a transition is gone. The examples all use glass.
- **Starting key.** The piece's own key (`piece.key`) has no control. A key moment at 0:00 does the same job. Do you want a Key control in piece settings, or should it come with M4.5-27 ("the start is a moment")?

## Decided by the integrator (veto if wrong)
- **Build order.** "The start is a moment" (M4.5-27) comes before rev 9's Parts (R9-1). Both change the file format, and this way pieces migrate once. The rest of rev 9 follows Parts. "Compose for me" (M4.5-28) runs alongside Parts.
- **A click on the score never pans the view.** A click on empty score seeks the playhead and holds the view still, as the ruler already did, so a double-click lands where you clicked. Before this, Smooth follow could pan 3 s between the two clicks.
- **Silent lines (R9-5).**
  - Each line's opacity follows its level and its fade-in and fade-out.
  - In the editor, a selected or hovered line below 25 % opacity shows as a faint dotted trace.
  - In the player, silent lines can't be hovered, so no readout appears over empty paper.
  - Two level moments with exactly the same span both show the trace.
- **Free octaves stay inside the chord's register (follow-up to 29a).** When a chord targets only some lines and the register runs out of free notes, the extra notes no longer drop below the register or cross the lines it doesn't touch. They take free octaves inside the register first, then between the untouched neighbours within the lines' range, and merge only when neither has room. The Cartographers' Rain chord `CrChd2` had put two notes at 59 and 43, below a register of 60–84 and under eight untouched lines. "Between the untouched neighbours" means the room stops at the nearest untouched line on that side, including untouched lines inside the register below or above the targeted ones. In Cartographers' Rain, two of `CrChd2`'s notes now merge on 79. The piece is 0.13 s longer, and its warning is gone.
- **Space (M4.5-37).**
  - Space plays and pauses everywhere except while typing in a text field.
  - Space held during a drag still pans. In the editor, play/pause therefore happens when Space is released, not when it's pressed.
  - Inside an open dialog, Space works as the browser normally does.
  - The degree picker's chips use Enter instead of Space.
  - Enter now ticks checkboxes and selects lane items.
- **Drag preview and auditioning (M4.5-35).**
  - Auditions play only while the transport is stopped; during playback the edit is heard live anyway.
  - Selecting a moment plays its target notes once.
  - Picks in the inspector play the result once, for about 1.5 s.
  - A dragged note sounds at each snapped pitch.
  - Hover previews are visual only: dashed ghost lines, shown during playback too.
  - Not sounding yet: ▲/▼ on walk steps and on chord notes in the inspector, and Shift+▲/▼ on dots. These will be added once the inspector work settles.
- **Key carry-forward (M4.5-36).**
  - "Carry it forward" is read as: a key change offers to move the fixed notes up to the next key change, and later key moments are not shifted.
  - Fixed notes are remapped by scale degree. The tonic moves the shorter way, with ties going down.
  - The prompt reads like this: "9 moments until the end use fixed notes. Move them to E lydian?". Move joins the key edit's undo entry.
  - A named chord stays a named chord when only the tonic changes, for example Dmaj7#11 becomes Amaj7#11. When the scale changes, it becomes the list of pitches it plays.
  - "Home to …" suggestions now follow the key. "Thin to …" and "Collapse to …" a non-tonic note still write fixed pitches until schema v2 (M4.5-27), so they get the prompt like any other fixed notes.
  - Follow-up: a note change whose starting note is held from before the key change is no longer remapped there, because remapping it made it miss its note.
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
