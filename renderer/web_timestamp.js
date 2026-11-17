(function initializeWebTimestamp(root, factory) {
  const api = factory(root);
  root.XYZWebTimestamp = api;
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root.document && root.location) {
    api.start();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createWebTimestamp(root) {
  const MAX_TIMESTAMP_SECONDS = 12 * 60 * 60;
  const preparedAudio = new WeakSet();

  function setDiagnostic(documentValue, key, value) {
    const dataset = documentValue?.documentElement?.dataset;
    if (dataset) dataset[key] = String(value);
  }

  function timestampFromUrl(value) {
    try {
      const url = new URL(String(value || ""));
      const raw = url.searchParams.get("t");
      if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return null;
      return Math.min(MAX_TIMESTAMP_SECONDS, Math.max(0, Math.floor(Number(raw))));
    } catch {
      return null;
    }
  }

  function seekAudio(documentValue, seconds) {
    const audio = documentValue?.querySelector?.("audio");
    if (!audio || audio.readyState < 1) return false;
    const maximum = Number.isFinite(audio.duration) && audio.duration > 0
      ? Math.max(0, audio.duration - 0.25)
      : seconds;
    audio.currentTime = Math.min(seconds, maximum);
    const applied = Math.abs(audio.currentTime - Math.min(seconds, maximum)) < 1;
    if (applied) {
      setDiagnostic(documentValue, "xiaoyuzhouTimestampState", "applied");
    }
    return applied;
  }

  function prepareAudio(documentValue, seconds) {
    const audio = documentValue?.querySelector?.("audio");
    if (!audio) return false;
    if (!preparedAudio.has(audio)) {
      preparedAudio.add(audio);
      setDiagnostic(documentValue, "xiaoyuzhouTimestampState", "armed");
      const seek = () => seekAudio(documentValue, seconds);
      audio.addEventListener("loadedmetadata", seek, { once: true });
      audio.addEventListener("play", seek, { once: true });
    }
    return seekAudio(documentValue, seconds);
  }

  function start() {
    const seconds = timestampFromUrl(root.location?.href);
    if (seconds === null) return;
    setDiagnostic(root.document, "xiaoyuzhouTimestampTarget", seconds);
    let attempts = 0;
    const timer = root.setInterval(() => {
      attempts += 1;
      if (prepareAudio(root.document, seconds) || attempts >= 80) {
        root.clearInterval(timer);
      }
    }, 250);
  }

  return {
    prepareAudio,
    seekAudio,
    start,
    timestampFromUrl
  };
});
