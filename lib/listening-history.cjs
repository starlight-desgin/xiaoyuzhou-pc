const positive = value => Number.isFinite(value) && value > 0 ? value : 0;

function ownerOf(auth) {
  const user = auth?.user;
  return String(user?.uid || user?.id || user?.userId || '');
}

// Keep only what the player needs to show the row offline and resolve a fresh stream.
function compactEpisode(episode) {
  if (!episode) return null;
  const eid = episode.eid || (episode.type === 'EPISODE' && episode.id);
  if (!eid) return null;
  const podcast = episode.podcast || {};
  const cover = podcast.image?.picUrl || podcast.image?.largePicUrl || podcast.image?.middlePicUrl ||
    podcast.image?.thumbnailUrl || podcast.cover?.url || podcast.imageUrl || episode.image?.picUrl ||
    episode.image?.middlePicUrl || episode.imageUrl || episode.cover?.url || '';
  return {
    type: 'EPISODE', eid: String(eid), title: episode.title || episode.name || '未命名单集',
    podcast: { pid: podcast.pid || podcast.id || episode.pid || '', title: podcast.title || podcast.name || '', imageUrl: cover },
    imageUrl: cover, duration: positive(episode.duration) || positive(episode.media?.duration),
    audioUrl: episode.media?.source?.url || episode.media?.url || episode.enclosure?.url || episode.audioUrl || episode.url || '',
    pubDate: episode.pubDate || episode.publishedAt || ''
  };
}

class ListeningHistory {
  constructor(store, now = Date.now) {
    this.store = store;
    this.now = now;
    this.accounts = store.get('accounts', {});
    this.dirty = false;
    this.lastSave = 0;
  }
  list(owner) {
    return owner ? this.accounts['user:' + owner] || [] : [];
  }
  find(owner, eid) {
    return this.list(owner).find(record => record.episode.eid === eid) || null;
  }
  record(owner, { episode, currentTime, duration, rate, ended }, force = false) {
    const item = compactEpisode(episode);
    if (!owner || !item || !Number.isFinite(currentTime) || currentTime < 0) return;
    const entries = this.list(owner);
    const index = entries.findIndex(record => record.episode.eid === item.eid);
    const previous = entries[index];
    const total = positive(duration) || item.duration || previous?.duration || 0;
    const position = total ? Math.min(currentTime, total) : currentTime;
    const finished = Boolean(ended || (total > 0 && position >= total));
    const record = { episode: item, currentTime: position, duration: total,
      rate: positive(rate) || previous?.rate || 1, completed: finished, updatedAt: this.now() };
    if (index !== -1) entries.splice(index, 1);
    entries.unshift(record);
    this.accounts['user:' + owner] = entries;
    this.dirty = true;
    if (force || this.now() - this.lastSave >= 5000) this.flush();
  }
  flush() {
    if (!this.dirty) return;
    this.store.set('accounts', this.accounts);
    this.lastSave = this.now();
    this.dirty = false;
  }
  importPrevious(owner, legacy) {
    if (!owner || !legacy?.episode || this.store.get('importedV1', false)) return;
    if (!this.find(owner, compactEpisode(legacy.episode)?.eid)) this.record(owner, legacy, true);
    this.store.set('importedV1', true);
  }
}

module.exports = { ListeningHistory, ownerOf, compactEpisode };
