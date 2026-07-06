'use strict';

// Regression coverage for the "phantom Bank 0/0" bug: a Program Change
// must NOT be preceded by Bank Select (CC#0 MSB / CC#32 LSB) when the
// user never set a bank (msb == lsb == 0). Bank Select must still be
// emitted when either MSB or LSB is non-zero, and the Program Change
// (0xC0) is always sent.
//
// screen.js is browser code (no module exports, references document /
// navigator / localStorage at call time but not at load time). We load
// the real source into a Function scope, stub the browser globals, and
// grab handles to the actual midiSend plus its module-scoped _midiOutput.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');

function loadMidiSend() {
    const sent = [];
    const factory = new Function(
        'document', 'navigator', 'localStorage', 'window', 'console',
        src + '\nreturn { midiSend, setOut(o){ _midiOutput = o; } };'
    );
    const stub = new Proxy({}, { get: () => () => undefined });
    const api = factory(stub, stub, stub, stub, { log() {}, warn() {}, error() {} });
    api.setOut({ send: (msg) => sent.push(msg.slice()) });
    return { midiSend: api.midiSend, sent };
}

// midiSend(channel, msgType, ccNumber, value, msbNumber, lsbNumber, cc2Number, cc2Value)

test('PC with no bank (msb==lsb==0) emits ONLY Program Change, no Bank Select', () => {
    const { midiSend, sent } = loadMidiSend();
    midiSend(0, 'pc', null, 5, 0, 0);
    assert.deepStrictEqual(sent, [[0xC0, 5]]);
});

test('PC with non-zero MSB emits Bank Select MSB + LSB then Program Change', () => {
    const { midiSend, sent } = loadMidiSend();
    midiSend(0, 'pc', null, 5, 1, 0);
    assert.deepStrictEqual(sent, [
        [0xB0, 0x00, 1], // Bank Select MSB
        [0xB0, 0x20, 0], // Bank Select LSB
        [0xC0, 5],       // Program Change
    ]);
});

test('PC with non-zero LSB (MSB 0) still emits Bank Select', () => {
    const { midiSend, sent } = loadMidiSend();
    midiSend(0, 'pc', null, 5, 0, 2);
    assert.deepStrictEqual(sent, [
        [0xB0, 0x00, 0],
        [0xB0, 0x20, 2],
        [0xC0, 5],
    ]);
});

test('Program Change is sent unconditionally even with no bank', () => {
    const { midiSend, sent } = loadMidiSend();
    midiSend(3, 'pc', null, 42, 0, 0);
    assert.deepStrictEqual(sent, [[0xC0 | 3, 42]]);
});
