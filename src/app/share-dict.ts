/**
 * The preset deflate dictionary of v2 share links (share.ts): JSON fragments that packed pieces
 * often contain, rarest first (deflate reaches the end of the dictionary most cheaply).
 *
 * It is part of the link format: never edit it. A better dictionary needs a new payload version,
 * with this one kept so old links still open.
 */
const FRAGMENTS = [
  // Piece header, mix, view and end: once per piece.
  '"view":{"window":20,"colors":"ink","hud":false,"gridBpm":120,"snapBeats":false,"meter":4,',
  '"follow":"page","loop":{"start":0,"end":',
  '"mix":{"reverb":{"size":0.7,"decay":3.2,"damping":0.45,"preDelay":0.02,"returnLevel":0.35},',
  '"delay":{"time":0.375,"feedback":0.35,"returnLevel":0},"sends":{"reverb":0.5,"delay":0.25},',
  '"tone":{"tilt":0,"lowpassHz":20000},"limiter":{"ceilingDb":-1},"panAuto":"pitch"},',
  '"end":{"at":120,"fade":6},',
  '"timbres":{"sine":1,"glass":1,"reed":1,"organ":1,"pluck":1,"choir":1,"wobble":1},',
  '"harmonics":[1,0.5,0.25],"stretch":0,"brightness":{"tilt":0,"track":0},"detuneSpread":0,',
  '"accent":0,"articulation":{"amount":0,"attack":0.01,"decay":0.2},',
  '"vibrato":{"rate":5,"depthCents":0,"delay":0.5}},',
  '"tuning":{"referenceHz":440},',
  '{"format":"algorhythms","version":2,"meta":{"title":"Untitled","author":"AlgoRhythms examples",',
  '"created":"2026-11-20T00:00:00.000Z","modified":"2026-11-21T00:00:00.000Z",',
  '"license":"CC0-1.0"},"seed":',
  '"key":{"tonic":"C","scale":"major"},"key":{"tonic":"A","scale":"minor"},',
  '"scale":"pentatonic-major","scale":"pentatonic-minor","scale":"harmonic-minor",',
  '"scale":"mixolydian","scale":"lydian","scale":"phrygian","scale":"aeolian","scale":"dorian"},',
  '"defaults":{"glide":{"length":3,"jitter":0.2,"stagger":0.8,"order":"random","ease":"smootherstep"}},',
  '"voices":[{"id":"v1","name":"","color":"","timbre":"glass","pan":-0.5,"gain":1,"range":[38,84],',
  '"mute":true,"solo":true,"part":"Melody","sends":{"reverb":0.5,"delay":0.25}},',
  '{"timbre":"reed","pan":0.5,"gain":0.8,"range":[48,72],"part":"Chords"},',
  '{"timbre":"organ","pan":0,"gain":1.2,"range":[26,52],"part":"Bass"},',
  '{"timbre":"pluck"},{"timbre":"sine"},{"timbre":"choir"},{"part":"Pad"},{"part":"Lead"}],',
  // Moments: many per piece, the commonest last.
  '"moments":[{"type":"chord","id":"start0","at":0,"notes":{"kind":"pitches","pitches":[57]}},',
  '{"type":"key","at":0,"key":{"tonic":"D","scale":"dorian"}},',
  '{"type":"pin","at":0,"voice":"v1","pitch":60},',
  '{"type":"unison","at":0,"pitch":"tonic","octaves":true},',
  '{"type":"spread","at":0,"factor":1.5,"around":"median","snap":"chromatic"},',
  '{"type":"shift","at":0,"by":-2,"unit":"scaleSteps"},',
  '{"type":"merge","at":0,"count":1,"which":"bottom","fade":2},',
  '{"type":"split","at":0,"count":3,"notes":{"kind":"pitches","pitches":[52,57,64]},"voicing":"close"},',
  '{"type":"note","at":0,"from":60,"to":62,"back":1,"order":true,',
  '"changes":[{"from":60,"to":62}]},',
  '{"type":"walk","at":0,"until":30,"grid":0.5,"density":0.45,"steps":[-2,-1,1,2],"stepGlide":0.3,',
  '"bass":{"leap":[5,7]},"fixed":[{"tick":0,"voice":"v1","pitch":60},{"tick":1,"voice":"v2","pitch":',
  '"overrides":[{"voice":0,"pitch":60,"end":1,"weight":2}],"seed":1,"muted":true,',
  '"glide":{"arrive":"spread","order":"low-first","ease":"linear"},"ease":"cosine","ease":"expo",',
  '"ease":{"kind":"bezier","x1":0.4,"y1":0,"x2":0.2,"y2":1},',
  '"order":"high-first","order":"center-out","order":"outside-in",',
  '{"type":"chord","at":0,"notes":{"kind":"chord","symbol":"Am7"},"register":[48,72],',
  '"assign":"free","count":4,"byVoice":true},',
  '{"type":"chord","at":0,"notes":{"kind":"degrees","degrees":[0,2,4,6]},"voicing":"nearest"},',
  '{"type":"pulse","at":0,"target":{"voices":["v2"]},"until":60,"step":0.25,',
  '"pattern":[1,0,0.5,0],"decay":0.5,"floor":0.1,"mode":"updown","strike":false},',
  '{"type":"tune","at":0,"target":{"part":"Melody"},"glide":{"length":0.1,"ease":"smoothstep"},',
  '"notes":[60,0.5,62,0.5,64,1]},',
  '{"type":"level","at":0,"target":{"part":"Bass"},"label":"Intro","gain":0.8,"over":1},',
  '{"type":"chord","at":2000,"target":{"part":"Chords"},',
  '"glide":{"length":0.5,"jitter":0.2,"stagger":0.1,"land":true,"ease":"smoothstep"},',
  '"notes":{"kind":"pitches","pitches":[45,52,57,60,64]}},',
];

export const SHARE_DICTIONARY_V2 = FRAGMENTS.join('');
