# MIDI Amp Control Plugin Constitution

This plugin sends MIDI messages to an external amp / modeler when the
song's tone changes during playback, so a hardware preset switches
automatically.

## Principles

### 1. Web MIDI API Only

The plugin uses `navigator.requestMIDIAccess()` exclusively. We do not
support virtual MIDI loopbacks via WebSockets or any custom Slopsmith
backend bridge. This means Chrome / Edge only — Firefox is documented
as unsupported.

### 2. Per-Song Mappings, Stored Server-Side

Mappings are persisted in a SQLite DB (`midi_mappings.db` under
Slopsmith's `config_dir`). The frontend reads / writes via REST. We
do not depend on `localStorage` for mappings — multiple browsers /
devices should see the same mapping for the same song.

### 3. CC + PC, Both First-Class

Some amps need Program Change, others need a CC for bank select or a
specific switch. The DB schema and UI MUST treat both as first-class:
`msg_type` is one of `cc | pc`, and `cc_number` + `value` carry the
payload. The legacy schema (program / bank MSB / bank LSB) implied by
older docs is **not** the current shape.

### 4. PSARC Tone Discovery, Sloppak Returns Empty

Tone discovery walks the PSARC's JSON entries for `Tones[].Key /
.Name`. Sloppaks have no RS-format tone manifest, so the endpoint
MUST return `{tones: []}` rather than 500 on the magic-byte check.

### 5. Test Button Is the Truth

The test button sends the same exact MIDI message the player will
send during playback. The user-facing contract is "if test makes the
right preset light up, playback will too" — no hidden differences.

## Inherits from Slopsmith Core Constitution

- `setup(app, context)` contract; uses `config_dir` and
  `get_dlc_dir`.
- Routes under `/api/plugins/midi_amp/...`.
- Plugin loader serves only the files referenced by `plugin.json`.

Where this plugin's principles disagree with the core constitution,
the core wins.
