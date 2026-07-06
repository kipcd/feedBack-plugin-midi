// MIDI Amp Control plugin
// Sends MIDI Program Change messages when song tones change during playback.

let _midiAccess = null;
let _midiOutput = null;
let _midiEnabled = false;
let _midiMappings = {};  // tone_key -> {channel, bank_msb, bank_lsb, program}
let _midiCurrentTone = null;
let _midiCurrentFilename = null;

// ── Web MIDI API ────────────────────────────────────────────────────────

async function midiInit() {
    const status = document.getElementById('midi-status');
    if (!navigator.requestMIDIAccess) {
        status.innerHTML = `
            <div class="bg-red-900/20 border border-red-800/30 rounded-xl p-4 text-sm">
                <p class="text-red-400 font-semibold">Web MIDI not supported</p>
                <p class="text-gray-400">Use Chrome or Edge. Firefox does not support Web MIDI.</p>
            </div>`;
        return;
    }

    try {
        _midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        _updateMidiDevices();
        _midiAccess.onstatechange = _updateMidiDevices;
    } catch (e) {
        status.innerHTML = `
            <div class="bg-red-900/20 border border-red-800/30 rounded-xl p-4 text-sm">
                <p class="text-red-400 font-semibold">MIDI access denied</p>
                <p class="text-gray-400">${e.message}</p>
            </div>`;
    }
}

function setupTestBankToggle() {
    const typeSelect = document.getElementById('midi-test-type');
    const msbField = document.getElementById('msb-field');
    const lsbField = document.getElementById('lsb-field');
    
    if (!typeSelect || !msbField) return;
    if (!typeSelect || !lsbField) return;

    function toggleBank() {
        if (typeSelect.value === 'pc') {
            msbField.classList.remove('hidden');
            lsbField.classList.remove('hidden');
        } else {
            msbField.classList.add('hidden');
            lsbField.classList.add('hidden');
        }
    }

    // Clear any older listeners by replacing the change event handler assignment
    typeSelect.onchange = toggleBank;
    // Sync initial state on device load/creation
    toggleBank();
}

function _updateMidiDevices() {
    const status = document.getElementById('midi-status');
    if (!_midiAccess) return;

    const outputs = [];
    _midiAccess.outputs.forEach(o => outputs.push(o));

    if (outputs.length === 0) {
        status.innerHTML = `
            <div class="bg-yellow-900/20 border border-yellow-800/30 rounded-xl p-4 text-sm">
                <p class="text-yellow-400 font-semibold">No MIDI output devices</p>
                <p class="text-gray-400">Connect your amp/modeler via USB MIDI.</p>
            </div>`;
        _midiOutput = null;
        document.getElementById('midi-test').classList.add('hidden');
        return;
    }

    // Auto-select first output, or use saved preference
    const savedId = localStorage.getItem('midi_output_id');
    _midiOutput = outputs.find(o => o.id === savedId) || outputs[0];

    let html = `<div class="bg-dark-700/50 border border-gray-800/50 rounded-xl p-3 flex items-center gap-3">
        <span class="text-green-400 text-xs">MIDI Ready</span>
        <select id="midi-device-select" onchange="midiSelectDevice(this.value)"
            class="bg-dark-600 border border-gray-700 rounded-lg px-2 py-1 text-xs text-gray-300 outline-none">`;
    for (const o of outputs) {
        const selected = o.id === _midiOutput.id ? 'selected' : '';
        html += `<option value="${o.id}" ${selected}>${esc(o.name)}</option>`;
    }
    html += `</select></div>`;
    status.innerHTML = html;
    document.getElementById('midi-test').classList.remove('hidden');
    setupTestBankToggle();
}

function midiSelectDevice(id) {
    if (!_midiAccess) return;
    _midiAccess.outputs.forEach(o => {
        if (o.id === id) _midiOutput = o;
    });
    localStorage.setItem('midi_output_id', id);
}

function toggleRowBankFields(row) {
    const typeSelect = row.querySelector('[data-field="msg_type"]');
    const msbCol = row.querySelector('[data-field="bank_msb"]')?.closest('div');
    const lsbCol = row.querySelector('[data-field="bank_lsb"]')?.closest('div');
    if (!typeSelect || !msbCol || !lsbCol) return;

    const isPC = typeSelect.value === 'pc';
    msbCol.classList.toggle('hidden', !isPC);
    lsbCol.classList.toggle('hidden', !isPC);
}

// Range validators. Bit-masking out-of-range values would silently
// wrap them onto a different MIDI byte — e.g. bank 16384 → 0/0,
// CC#128 → CC#0 (Bank Select MSB) — and clobber the user's bank.
// Better to drop the message than to send a wrong one.
function _isCcNum(n)       { return Number.isInteger(n) && n >= 0 && n <= 127; }
function _is7Bit(n)        { return Number.isInteger(n) && n >= 0 && n <= 127; }

function midiSend(channel, msgType, ccNumber, value, msbNumber, lsbNumber, cc2Number, cc2Value) {
    if (!_midiOutput) return;
    const ch = channel & 0x0F;
    const msbNumberRaw = (msbNumber) ? msbNumber : 0;
    const lsbNumberRaw = (lsbNumber) ? lsbNumber : 0;
    const cc2NumberRaw  = (cc2Number != null && Number.isFinite(cc2Number))
        ? cc2Number : null;
    const cc2ValueRaw   = (Number.isFinite(cc2Value)) ? cc2Value : 0;
    if (msgType === 'cc') {
        if (_isCcNum(ccNumber) && _is7Bit(value)) {
            _midiOutput.send([0xB0 | ch, ccNumber, value]);
            console.log(`[MIDI] Ch${ch} CC#${ccNumber} = ${value}`);
        } else {
            console.warn(`[MIDI] CC ${ccNumber}=${value} out of range 0-127; skipping`);
        }
    } else {
        // Only emit Bank Select (CC#0 MSB / CC#32 LSB) when the user
        // actually set a bank. Sending MSB:0/LSB:0 on every Program
        // Change forces bank 0 on multi-bank synths/modelers and picks
        // the wrong patch — the "phantom Bank 0/0" problem. Skip both
        // sends when msb and lsb are both 0; send when either is set.
        if (msbNumberRaw !== 0 || lsbNumberRaw !== 0) {
            if (_is7Bit(msbNumberRaw)) {
                _midiOutput.send([0xB0 | ch, 0x00, msbNumberRaw]);  // Bank Select MSB
                console.log(`[MIDI] Ch:${ch} MSB:${msbNumberRaw}`);
            } else {
                console.warn(`[MIDI] MSB ${msbNumberRaw} out of range 0-127; skipping MSB`);
            }
            if (_is7Bit(lsbNumberRaw)) {
                _midiOutput.send([0xB0 | ch, 0x20, lsbNumberRaw]);
                console.log(`[MIDI] Ch:${ch} LSB:${lsbNumberRaw}`);
            } else {
                console.warn(`[MIDI] LSB ${lsbNumberRaw} out of range 0-127; skipping`);
            }
        }
        if (_is7Bit(value)) {
            _midiOutput.send([0xC0 | ch, value]);
            console.log(`[MIDI] Ch${ch} ${value}`);
        } else {
            console.warn(`[MIDI] PC ${value} out of range 0-127; skipping`);
        }
    }
    // Optional second CC fired regardless of msgType — useful for
    // tone-shape macros tied to the same tone change. Skip rather
    // than wrap when the CC# or value is out of the 0-127 range.
    if (cc2NumberRaw !== null) {
        if (_isCcNum(cc2NumberRaw) && _is7Bit(cc2ValueRaw)) {
            _midiOutput.send([0xB0 | ch, cc2NumberRaw, cc2ValueRaw]);
            console.log(`[MIDI] Ch${ch} CC2#${cc2NumberRaw} = ${cc2ValueRaw}`);
        } else {
            console.warn(`[MIDI] CC2 ${cc2NumberRaw}=${cc2ValueRaw} out of range 0-127; skipping`);
        }
    }
}

function midiTestSend() {
    const ch = parseInt(document.getElementById('midi-test-ch').value) || 0;
    const type = document.getElementById('midi-test-type').value;
    const cc = parseInt(document.getElementById('midi-test-cc').value) || 0;
    const msb = parseInt(document.getElementById('midi-test-msb').value) || 0;
    const lsb = parseInt(document.getElementById('midi-test-lsb').value) || 0;
    const val = parseInt(document.getElementById('midi-test-val').value) || 0;
    // Empty cc2 input → "no second CC". parseInt('') is NaN, which
    // midiSend treats as null. Don't fall through to ||0 because 0
    // is a valid CC# (Bank Select MSB).
    const cc2Raw = document.getElementById('midi-test-cc2').value;
    const cc2 = cc2Raw === '' ? null : parseInt(cc2Raw, 10);
    const cc2val = parseInt(document.getElementById('midi-test-cc2val').value) || 0;
    midiSend(ch, type, cc, val, msb, lsb, cc2, cc2val );
}

// ── Mapping Editor ──────────────────────────────────────────────────────

async function midiSearchSongs() {
    const q = document.getElementById('midi-search').value.trim();
    if (!q) return;
    const resp = await fetch(`/api/library?q=${encodeURIComponent(q)}&page=0&size=10&sort=artist`);
    const data = await resp.json();
    const container = document.getElementById('midi-search-results');

    if (!data.songs || data.songs.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-xs py-2">No results</p>';
        return;
    }

    container.innerHTML = data.songs.map(s => `
        <div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition cursor-pointer"
             onclick="midiEditSong('${encodeURIComponent(s.filename)}', '${esc(s.title).replace(/'/g,"\\'")} - ${esc(s.artist).replace(/'/g,"\\'")}')">
            <div class="flex-1 min-w-0">
                <span class="text-sm text-white">${esc(s.title)}</span>
                <span class="text-xs text-gray-500 ml-2">${esc(s.artist)}</span>
            </div>
            <svg class="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
        </div>
    `).join('');
}

async function midiEditSong(encodedFilename, displayName) {
    const filename = decodeURIComponent(encodedFilename);
    document.getElementById('midi-search-results').innerHTML = '';
    document.getElementById('midi-editor').classList.remove('hidden');
    document.getElementById('midi-editor-title').textContent = displayName;

    // Fetch tones and existing mappings in parallel
    const [tonesResp, mappingsResp] = await Promise.all([
        fetch(`/api/plugins/midi_amp/song-tones/${encodeURIComponent(filename)}`),
        fetch(`/api/plugins/midi_amp/mappings/${encodeURIComponent(filename)}`),
    ]);
    const tonesData = await tonesResp.json();
    const mappingsData = await mappingsResp.json();

    const tones = tonesData.tones || [];
    const mappingsByKey = {};
    for (const m of mappingsData) {
        mappingsByKey[m.tone_key] = m;
    }

    const container = document.getElementById('midi-mappings');
    if (tones.length === 0) {
        container.innerHTML = '<p class="text-gray-500 text-sm">No tones found in this song.</p>';
        return;
    }

    container.innerHTML = tones.map(t => {
        const m = mappingsByKey[t.key] || {};
        const msgType = m.msg_type || 'cc';
        return `<div class="bg-dark-700/50 border border-gray-800/50 rounded-xl p-4">
            <div class="flex items-center justify-between mb-3">
                <div>
                    <span class="text-sm font-semibold text-white">${esc(t.name)}</span>
                    <span class="text-xs text-gray-600 ml-2">${esc(t.arrangement)}</span>
                </div>
                <button onclick="midiTestMapping('${t.key}')" class="px-2 py-1 bg-dark-600 hover:bg-dark-500 rounded text-xs text-gray-400 transition">Test</button>
            </div>
            <div class="grid grid-cols-4 gap-3">
                <div>
                    <label class="text-[10px] text-gray-500 block mb-1">Type</label>
                    <select data-tone="${t.key}" data-field="msg_type"
                        class="midi-field w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                        <option value="cc" ${msgType === 'cc' ? 'selected' : ''}>CC</option>
                        <option value="pc" ${msgType === 'pc' ? 'selected' : ''}>PC</option>
                    </select>
                </div>
                <div>
                    <label class="text-[10px] text-gray-500 block mb-1">Channel</label>
                    <input type="number" min="0" max="15" value="${m.channel || 0}"
                        data-tone="${t.key}" data-field="channel"
                        class="midi-field w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                </div>
                <div>
                    <label class="text-[10px] text-gray-500 block mb-1">CC#</label>
                    <input type="number" min="0" max="127" value="${m.cc_number || 0}"
                        data-tone="${t.key}" data-field="cc_number"
                        class="midi-field w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                </div>
                <div>
                    <label class="text-[10px] text-gray-500 block mb-1">Value</label>
                    <input type="number" min="0" max="127" value="${m.value || 0}"
                        data-tone="${t.key}" data-field="value"
                        class="midi-field w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                </div>
                <div>
                    <label class="text-[10px] text-gray-500 block mb-1">MSB</label>
                    <input type="number" min="0" max="127" value="${m.bank_msb || 0}"
                        data-tone="${t.key}" data-field="bank_msb"
                        class="midi-field w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                </div>
                <div>
                    <label class="text-[10px] text-gray-500 block mb-1">LSB</label>
                    <input type="number" min="0" max="127" value="${m.bank_lsb || 0}"
                        data-tone="${t.key}" data-field="bank_lsb"
                        class="midi-field w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                </div>
                <div>
                    <label class="text-[10px] text-gray-500 block mb-1">CC2#</label>
                    <input type="number" min="0" max="127" value="${m.cc2_number ?? ''}" placeholder="—"
                        data-tone="${t.key}" data-field="cc2_number"
                        class="midi-field w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                </div>
                <div>
                    <label class="text-[10px] text-gray-500 block mb-1">CC2 Value</label>
                    <input type="number" min="0" max="127" value="${m.cc2_value || 0}"
                        data-tone="${t.key}" data-field="cc2_value"
                        class="midi-field w-full bg-dark-600 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-300 outline-none">
                </div>
            </div>
        </div>`;
    }).join('');

    // Sync initial visibility state for all generated rows
    container.querySelectorAll('.rounded-xl').forEach(row => {
        toggleRowBankFields(row);
    });
    // Auto-save and visibility sync on change
    container.querySelectorAll('.midi-field').forEach(input => {
        input.addEventListener('change', () => {
            const toneKey = input.dataset.tone;
            const row = input.closest('.rounded-xl');
            if (input.dataset.field === 'msg_type') {
                toggleRowBankFields(row);
            }
            const fields = row.querySelectorAll('.midi-field');
            const mapping = { tone_key: toneKey, tone_name: toneKey };
            fields.forEach(f => {
                const field = f.dataset.field;
                if (field === 'msg_type') {
                    mapping[field] = f.value;
                } else if (field === 'cc2_number') {
                    // Empty input → null sentinel. parseInt('')||0 would
                    // store 0 here, but CC#0 is Bank Select MSB — sending
                    // it as a "second CC" on every tone change would clobber
                    // the user's bank. null = "no second CC, skip".
                    mapping[field] = f.value === '' ? null : (parseInt(f.value, 10) || 0);
                } else {
                    mapping[field] = parseInt(f.value) || 0;
                }
            });
            fetch(`/api/plugins/midi_amp/mappings/${encodeURIComponent(filename)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(mapping),
            });
        });
    });
}

function midiTestMapping(toneKey) {
    const container = document.getElementById('midi-mappings');
    const fields = container.querySelectorAll(`[data-tone="${toneKey}"]`);
    let ch = 0, msgType = 'cc', ccNum = 0, val = 0;
    let msbNum = 0, lsbNum = 0, cc2Num = null, cc2Val = 0;
    fields.forEach(f => {
        const field = f.dataset.field;
        if (field === 'channel') ch = parseInt(f.value) || 0;
        else if (field === 'msg_type') msgType = f.value;
        else if (field === 'cc_number') ccNum = parseInt(f.value) || 0;
        else if (field === 'value') val = parseInt(f.value) || 0;
        else if (field === 'bank_msb') msbNum = parseInt(f.value) || 0;
        else if (field === 'bank_lsb') lsbNum = parseInt(f.value) || 0;
        else if (field === 'cc2_number') cc2Num = f.value === '' ? null : (parseInt(f.value, 10) || 0);
        else if (field === 'cc2_value') cc2Val = parseInt(f.value) || 0;
    });
    midiSend(ch, msgType, ccNum, val, msbNum, lsbNum, cc2Num, cc2Val);
}

// ── Player Integration: auto-switch on tone change ──────────────────────

async function _midiLoadMappings(filename) {
    _midiCurrentFilename = filename;
    _midiMappings = {};
    _midiCurrentTone = null;
    try {
        const resp = await fetch(`/api/plugins/midi_amp/mappings/${encodeURIComponent(decodeURIComponent(filename))}`);
        const data = await resp.json();
        for (const m of data) {
            _midiMappings[m.tone_key] = m;
        }
        _midiEnabled = Object.keys(_midiMappings).length > 0;
    } catch (e) {
        _midiEnabled = false;
    }
}

function _midiCheckToneChange() {
    if (!_midiEnabled || !_midiOutput || !_midiCurrentFilename) return;

    const t = highway.getTime();
    const changes = highway.getToneChanges();
    const base = highway.getToneBase();

    if (!changes || changes.length === 0) return;

    // Find the active tone at current time
    let activeTone = base;
    for (const tc of changes) {
        if (tc.t <= t) {
            activeTone = tc.name;
        } else {
            break;
        }
    }

    if (activeTone && activeTone !== _midiCurrentTone) {
        _midiCurrentTone = activeTone;
        // Look up mapping for this tone
        const mapping = _midiMappings[activeTone];
        if (mapping) {
            // Normalize empty strings, undefined, or null to null so midiSend safely skips it
            const cc2Num = (mapping.cc2_number === '' || mapping.cc2_number == null) ? null : mapping.cc2_number;
            midiSend(mapping.channel, mapping.msg_type, mapping.cc_number, mapping.value, mapping.bank_msb, mapping.bank_lsb, cc2Num, mapping.cc2_value || 0);
            console.log(`[MIDI] Tone switch: ${activeTone} -> Ch${mapping.channel} ${mapping.msg_type}#${mapping.cc_number}=${mapping.value}`);
        }
    }
}

// Side effects: tone-change poller + playSong wrapper. Consolidated under
// one idempotency guard with the showScreen wrapper below so re-evaluation
// (loader cache miss, hot reload, older core builds without the load-side
// guard) doesn't start a second 10Hz poller and doesn't grow the wrapper
// chains.
(function() {
    const HOOK_KEY = '__slopsmithMidiHooksInstalled';
    if (window[HOOK_KEY]) return;
    window[HOOK_KEY] = true;

    // Poll for tone changes during playback
    setInterval(_midiCheckToneChange, 100);

    // Hook into playSong
    const origPlaySong = window.playSong;
    window.playSong = async function(filename, arrangement) {
        await origPlaySong(filename, arrangement);
        _midiInjectButton();
        _midiLoadMappings(filename);
    };

    // Init on screen show (wrapped here so the same guard covers it).
    const origShowScreen = window.showScreen;
    window.showScreen = function(id) {
        origShowScreen(id);
        if (id === 'plugin-midi_amp') midiInit();
    };
})();

function _midiInjectButton() {
    // v3: mount into the host's stable plugin-control slot (Plugins rail
    // popover). The legacy DOM-injection anchor resolves to a NESTED
    // transport button in v3 and would throw on insertBefore; the slot is
    // always present in v3, so that anchor is only used in the classic UI.
    const isV3 = !!(window.slopsmith && window.slopsmith.uiVersion === 'v3');
    let slot = null;
    if (isV3 && window.slopsmith.ui && typeof window.slopsmith.ui.playerControlSlot === 'function') {
        try { const _s = window.slopsmith.ui.playerControlSlot(); if (_s instanceof Element) slot = _s; }
        catch (_e) { /* host slot API failure → fall back to legacy container */ }
    }
    const controls = slot || document.getElementById('player-controls');
    if (!controls || document.getElementById('btn-midi')) return;

    const closeBtn = isV3 ? null : controls.querySelector(':scope > button:last-of-type');
    const btn = document.createElement('button');
    btn.id = 'btn-midi';
    btn.className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
    btn.textContent = 'MIDI';
    btn.title = 'Configure MIDI mappings for this song';
    btn.onclick = () => {
        const filename = decodeURIComponent(_midiCurrentFilename);
        const title = document.getElementById('hud-title')?.textContent || '';
        const artist = document.getElementById('hud-artist')?.textContent || '';
        showScreen('plugin-midi_amp');
        midiEditSong(encodeURIComponent(filename), `${title} - ${artist}`);
    };
    if (closeBtn) controls.insertBefore(btn, closeBtn);
    else controls.appendChild(btn);
}