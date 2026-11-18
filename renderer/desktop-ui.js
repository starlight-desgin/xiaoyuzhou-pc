(function () {
  const desktop = window.xyzDesktop;
  const audio = document.querySelector('#audio');
  function refresh(value) {
    document.querySelector('#desktop-notifications').checked = value.settings.notifications;
    document.querySelector('#desktop-close-to-tray').checked = value.settings.closeToTray;
    document.querySelector('#desktop-minimize-to-tray').checked = value.settings.minimizeToTray;
    const updates = value.updates;
    document.querySelector('#desktop-update-status').textContent = updates.checking ? '正在检查你的订阅…'
      : updates.error || (updates.lastChecked ? `最近检查 ${new Date(updates.lastChecked).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${updates.newCount ? `${updates.newCount} 个新单集` : '已是最新'}` : '首次检查会建立记录，不会重复提醒旧单集');
  }
  document.querySelector('#desktop-options-button').addEventListener('click', async () => {
    try { refresh(await desktop.status()); document.querySelector('#desktop-options-dialog').showModal(); }
    catch (error) { notify(error.message); }
  });
  document.querySelector('#desktop-hide-button').addEventListener('click', () => desktop.hide());
  document.querySelector('#desktop-quit').addEventListener('click', () => desktop.quit());
  for (const [selector, setting] of [['#desktop-notifications', 'notifications'], ['#desktop-close-to-tray', 'closeToTray'], ['#desktop-minimize-to-tray', 'minimizeToTray']]) {
    document.querySelector(selector).addEventListener('change', async event => {
      try { await desktop.settings({ [setting]: event.target.checked }); }
      catch (error) { notify(error.message); }
    });
  }
  document.querySelector('#desktop-check-updates').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    document.querySelector('#desktop-update-status').textContent = '正在检查你的订阅…';
    try { await desktop.checkUpdates(); refresh(await desktop.status()); }
    catch (error) { notify(error.message); }
    finally { document.querySelector('#desktop-check-updates').disabled = false; }
  });
  document.querySelector('#desktop-test-notification').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { const result = await desktop.testNotification(); notify(result.ok ? '测试通知已发送到 Windows' : result.error); }
    catch (error) { notify(error.message); }
    finally { document.querySelector('#desktop-test-notification').disabled = false; }
  });
  desktop.onStatus(refresh);
  desktop.onCommand(async command => {
    if (command.type === 'checkpoint') { recordPlayback('quit'); desktop.checkpoint(); return; }
    if (command.type === 'toggle-play') document.querySelector('#play-button').click();
    if (command.type === 'skip') skipBy(command.seconds);
    if (command.type === 'subscriptions') setRoute('subscriptions');
    if (command.type === 'open-episode') await openEpisode({ type: 'EPISODE', eid: command.eid }, { navigate: true });
  });
  function playback() {
    if (!state.current) return;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate,
          position: Math.max(0, Math.min(audio.duration, audio.currentTime)) });
      }
    }
  }
  for (const event of ['play', 'pause', 'timeupdate', 'seeked', 'ratechange', 'ended']) audio.addEventListener(event, playback);
  audio.addEventListener('loadedmetadata', () => {
    if ('mediaSession' in navigator && state.current) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: titleOf(state.current),
        artist: state.current.podcast?.title || '小宇宙', album: '小宇宙桌面版',
        artwork: imageOf(state.current) ? [{ src: imageOf(state.current) }] : [] });
    }
    playback();
  });
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', () => audio.play().catch(() => {}));
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', event => skipBy(-(event.seekOffset || 15)));
    navigator.mediaSession.setActionHandler('seekforward', event => skipBy(event.seekOffset || 30));
    navigator.mediaSession.setActionHandler('seekto', event => { if (Number.isFinite(event.seekTime)) skipBy(event.seekTime - audio.currentTime); });
  }
  desktop.status().then(refresh).catch(error => notify(error.message));
})();
