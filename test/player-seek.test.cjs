const test = require('node:test');
const assert = require('node:assert/strict');
const { attach } = require('../renderer/player-seek.js');
function target(properties = {}) {
  const events = new Map();
  return { ...properties, style: { setProperty() {} },
    setAttribute() {}, addEventListener(name, callback) { events.set(name, callback); },
    fire(name) { events.get(name)?.({ target: this }); } };
}
function setup(total = 300) {
  const audio = target({ duration: total, currentTime: 30, paused: true });
  const input = target({ value: 0 });
  const current = {}, duration = {};
  attach({ audio, input, current, duration, format: s => String(Math.floor(s)) });
  return { audio, input, current, duration };
}
test('drag previews time and ignores playback refresh until release', () => {
  const { audio, input, current } = setup();
  input.fire('pointerdown'); input.value = 80; input.fire('input');
  assert.equal(current.textContent, '240');
  assert.equal(audio.currentTime, 30);
  audio.currentTime = 31; audio.fire('timeupdate');
  assert.equal(Number(input.value), 80);
  input.fire('change');
  assert.equal(audio.currentTime, 240);
  assert.equal(audio.paused, true);
});
test('clicking the track and keyboard changes commit on change', () => {
  const { audio, input } = setup();
  input.value = 50; input.fire('input'); input.fire('change');
  assert.equal(audio.currentTime, 150);
  input.value = 55; input.fire('input'); input.fire('change');
  assert.equal(audio.currentTime, 165);
});
test('unknown, zero and infinite duration keep progress disabled', () => {
  for (const value of [NaN, 0, Infinity]) {
    const { input, audio } = setup(value);
    assert.equal(input.disabled, true);
    input.value = 50; input.fire('input'); input.fire('change');
    assert.equal(audio.currentTime, 30);
  }
});
test('cancelled drag restores playback position', () => {
  const { audio, input, current } = setup();
  input.fire('pointerdown'); input.value = 90; input.fire('input'); input.fire('pointercancel');
  assert.equal(Number(input.value), 10);
  assert.equal(current.textContent, '30');
  assert.equal(audio.currentTime, 30);
});
test('source switch resets a pending drag', () => {
  const { audio, input } = setup();
  input.fire('pointerdown'); input.value = 80; input.fire('input');
  audio.duration = NaN; audio.currentTime = 0; audio.fire('emptied');
  input.fire('change'); assert.equal(audio.currentTime, 0);
  audio.duration = 100; audio.fire('loadedmetadata');
  assert.equal(input.disabled, false);
  assert.equal(Number(input.value), 0);
});
