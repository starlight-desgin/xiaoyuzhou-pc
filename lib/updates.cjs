function listOf(response) {
  if (Array.isArray(response)) return response;
  const data = response?.data ?? response;
  if (Array.isArray(data)) return data;
  return data?.data ?? data?.list ?? data?.items ?? data?.episodes ?? data?.podcasts ?? [];
}
function unwrap(item) {
  if (item?.eid || item?.pid || (item?.id && (item.type === 'PODCAST' || item.type === 'EPISODE'))) return item;
  return item?.episode || item?.podcast || item?.target || item?.data || item;
}
function timestamp(item) {
  const value = item?.pubDate || item?.publishedAt || item?.createdAt;
  const parsed = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

class UpdateChecker {
  constructor({ request, store, notify, now = Date.now }) {
    this.request = request;
    this.store = store;
    this.notify = notify;
    this.now = now;
    this.busy = false;
    this.status = { checking: false, lastChecked: null, error: '', newCount: 0 };
  }
  async check() {
    if (this.busy) return this.status;
    this.busy = true;
    this.status.checking = true;
    try {
      const auth = await this.request({ type: 'get-auth' });
      if (!auth?.accessToken) throw new Error('登录后会自动检查订阅更新');
      const uid = auth.user?.uid || auth.user?.id || auth.user?.userId;
      if (!uid) throw new Error('请登录小宇宙后检查订阅更新');
      const allFeeds = { ...this.store.get('notificationFeeds', {}) };
      const feeds = { ...allFeeds[uid] };
      const podcasts = new Map();
      const cursors = new Set();
      let cursor;
      do {
        const response = await this.request({ type: 'api', payload: { endpoint: '/subscription', body: {
          limit: '100', sortOrder: 'desc', sortBy: 'subscribedAt', ...(cursor ? { loadMoreKey: cursor } : {})
        } } });
        for (const wrapped of listOf(response)) {
          const podcast = unwrap(wrapped);
          const pid = podcast?.pid || (podcast?.type === 'PODCAST' ? podcast.id : null);
          if (pid) podcasts.set(pid, podcast);
        }
        const next = response?.loadMoreKey || response?.data?.loadMoreKey;
        const key = next ? JSON.stringify(next) : '';
        if (!key || cursors.has(key)) break;
        cursors.add(key);
        cursor = next;
      } while (cursors.size < 50);
      const fresh = [];
      let failures = 0;
      for (const [pid, podcast] of podcasts) {
        try {
          const response = await this.request({ type: 'api', payload: { endpoint: '/episode_list', body: {
            pid, order: 'desc', limit: '20'
          } } });
          const episodes = listOf(response).map(unwrap).filter(e => e?.eid || (e?.type === 'EPISODE' && e.id));
          const previous = feeds[pid];
          const known = new Set(previous?.seen || []);
          // v1 sometimes stored an empty result for nonempty feeds whose episodes contained a podcast.
          if (previous && (previous.initialized || previous.latest > 0 || known.size)) {
            for (const episode of episodes) {
              const eid = episode.eid || episode.id;
              if (!known.has(eid) && timestamp(episode) >= previous.latest) {
                fresh.push({ ...episode, eid, podcast: episode.podcast || podcast });
              }
            }
          }
          feeds[pid] = {
            initialized: true,
            seen: [...new Set([...episodes.map(e => e.eid || e.id), ...known])].slice(0, 100),
            latest: Math.max(previous?.latest || 0, ...episodes.map(timestamp))
          };
        } catch {
          // Failed podcasts keep their baseline, so a transient error cannot lose updates.
          failures++;
        }
      }
      const active = await this.request({ type: 'get-auth' });
      if ((active?.user?.uid || active?.user?.id || active?.user?.userId) !== uid) throw new Error('账号已切换，稍后检查订阅更新');
      if (fresh.length) await this.notify(fresh);
      allFeeds[uid] = feeds;
      this.store.set('notificationFeeds', allFeeds);
      this.status = {
        checking: false, lastChecked: this.now(), newCount: fresh.length,
        error: failures ? `${failures} 个节目的更新暂时未能读取，下次会重试` : ''
      };
    } catch (error) {
      this.status.error = error.message;
    } finally {
      this.busy = false;
      this.status.checking = false;
    }
    return this.status;
  }
}
module.exports = { UpdateChecker, listOf, timestamp };
