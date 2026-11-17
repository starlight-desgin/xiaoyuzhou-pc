(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XYZPlayerSeek = factory();
})(globalThis, function () {
  function attach({ audio, input, current, duration, format, onTime = () => {}, getDuration = () => 0 }) {
    let dragging = false;
    let pending = null;
    const length = () => {
      const value = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : (audio.src ? getDuration() : 0);
      return Number.isFinite(value) && value > 0 ? value : 0;
    };
    const display = seconds => {
      const total = length();
      input.value = total ? Math.max(0, Math.min(100, seconds / total * 100)) : 0;
      input.style.setProperty('--played', `${input.value}%`);
      input.setAttribute('aria-valuetext', `${format(seconds)} / ${format(total)}`);
      current.textContent = format(seconds);
      duration.textContent = format(total);
      input.disabled = !total;
    };
    const sync = () => { if (!dragging && pending === null) display(audio.currentTime || 0); };
    const commit = () => {
      if (pending !== null && length()) {
        audio.currentTime = Math.max(0, Math.min(length(), pending));
        onTime(audio.currentTime);
      }
      pending = null;
      dragging = false;
      sync();
    };
    input.addEventListener('pointerdown', () => { if (!input.disabled) dragging = true; });
    input.addEventListener('input', () => {
      if (!length()) return;
      pending = Number(input.value) / 100 * length();
      display(pending);
    });
    input.addEventListener('change', commit);
    input.addEventListener('pointerup', commit);
    input.addEventListener('pointercancel', () => { pending = null; dragging = false; sync(); });
    input.addEventListener('blur', commit);
    audio.addEventListener('timeupdate', () => { sync(); onTime(audio.currentTime); });
    audio.addEventListener('durationchange', sync);
    audio.addEventListener('loadedmetadata', sync);
    audio.addEventListener('emptied', () => { pending = null; dragging = false; display(0); });
    sync();
    return { sync, commit };
  }
  return { attach };
});
