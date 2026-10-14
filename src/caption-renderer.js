(() => {
  const $ = id => document.getElementById(id);
  const lines = new Map();
  let active = false;
  let ready = false;
  let stopping = false;
  let busy = null;  // model being downloaded or speed-checked
  let selectedProfile = localStorage.getItem('captionProfile') || 'parakeet';
  let selectedDevice = localStorage.getItem('captionDevice') || '';
  const size = bytes => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

  function notice(text = '') {
    $('caption-notice').textContent = text;
    $('caption-notice').hidden = !text;
  }

  function updateStart() {
    const disabled = !ready || stopping || (busy !== null && !active);
    $('start-captions').disabled = disabled;
    // Mirror the control shown on the ChatGPT tab.
    const chatToggle = $('chat-start-captions');
    if (chatToggle) chatToggle.disabled = disabled;
  }

  function setStatus(label, state = 'idle') {
    active = state !== 'idle';
    stopping = state === 'stopping';
    const status = $('caption-status');
    status.lastChild.textContent = label;
    status.classList.toggle('active', active);
    $('audio-card').querySelector('strong').textContent = active ? 'Captions on' : 'Audio off';
    $('audio-card').querySelector('small').textContent = active ? 'English · On this PC' : 'Start it from Captions';
    $('caption-options').disabled = active;
    $('start-captions').textContent = active ? 'Stop captions' : 'Start captions';
    // Keep the ChatGPT tab's status chip and start/stop toggle in step.
    const chatStatus = $('chat-caption-status');
    if (chatStatus) {
      chatStatus.lastChild.textContent = label;
      chatStatus.classList.toggle('active', active);
    }
    const chatToggle = $('chat-start-captions');
    if (chatToggle) chatToggle.textContent = active ? 'Stop captions' : 'Start captions';
    updateStart();
    document.dispatchEvent(new CustomEvent('captions:status', { detail: label }));
    if (!active) $('caption-meter').value = 0;
  }

  function tag(text, suggested = false) {
    const element = document.createElement('em');
    element.className = `model-tag${suggested ? ' suggested' : ''}`;
    element.textContent = text;
    return element;
  }

  // Models ranked best first; each row offers download, cancel, or a speed check.
  function renderModels(models) {
    const list = $('caption-engine-options');
    list.replaceChildren();
    for (const m of models) {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.dataset.model = m.id;
      const label = choice(row, 'caption-engine', m.id, '', '', m.id === selectedProfile, !m.installed,
        () => { selectedProfile = m.id; localStorage.setItem('captionProfile', m.id); });
      const title = document.createElement('span');
      title.className = 'model-title';
      title.append(m.name, tag(m.label));
      if (m.recommended) title.append(tag('Suggested for this PC', true));
      const summary = document.createElement('small');
      summary.textContent = m.summary;
      const status = document.createElement('small');
      status.className = 'model-status';
      status.textContent = m.installed ? (m.checkNote || 'Installed.') : `${size(m.downloadBytes)} download · ${m.fitNote}`;
      const progress = document.createElement('progress');
      progress.max = 1;
      progress.hidden = true;
      label.querySelector('span').replaceChildren(title, summary, status, progress);
      if (!m.installed || !m.checkNote) {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'secondary-button model-action';
        action.textContent = m.installed ? 'Check speed' : 'Download';
        action.disabled = busy !== null && busy !== m.id;
        action.addEventListener('click', () => (busy === m.id ? window.privacy.cancelModelDownload(m.id) : prepareModel(m.id)));
        row.append(action);
      }
      list.append(row);
    }
  }

  async function prepareModel(id) {
    busy = id;
    notice();
    updateStart();
    for (const button of document.querySelectorAll('.model-action')) {
      const mine = button.closest('.model-row').dataset.model === id;
      button.disabled = !mine;
      if (mine) button.textContent = 'Cancel';
    }
    const result = await window.privacy.downloadModel(id);
    busy = null;
    await configure();
    if (!result.ok) notice(result.error);
  }

  function showModelProgress(event) {
    const row = $('caption-engine-options').querySelector(`[data-model="${event.id}"]`);
    if (!row) return;
    const status = row.querySelector('.model-status');
    const progress = row.querySelector('progress');
    if (event.phase === 'download' || event.phase === 'verify') {
      progress.hidden = false;
      progress.value = event.total ? event.done / event.total : 0;
      status.textContent = event.phase === 'verify' ? 'Verifying the download…'
        : `Downloading ${size(event.done)} of ${size(event.total)}… It resumes if interrupted.`;
    } else if (event.phase === 'installed' || event.phase === 'checking') {
      progress.hidden = true;
      status.textContent = 'Checking recognition speed on this PC…';
    } else if (event.phase === 'error') {
      progress.hidden = true;
      status.textContent = event.message;
    }
  }

  function choice(container, group, value, title, detail, selected, disabled, onChange) {
    const label = document.createElement('label');
    label.className = 'caption-choice';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = group;
    radio.value = value;
    radio.checked = selected;
    radio.disabled = disabled;
    radio.addEventListener('change', onChange);
    const copy = document.createElement('span');
    copy.textContent = title;
    if (detail) {
      const small = document.createElement('small');
      small.textContent = detail;
      copy.append(small);
    }
    label.append(radio, copy);
    container.append(label);
    return label;
  }

  async function configure() {
    $('start-captions').disabled = true;
    const config = await window.privacy.captionConfiguration();
    if (!config.models.some(m => m.id === selectedProfile && m.installed)) {
      selectedProfile = config.models.find(m => m.installed)?.id || 'parakeet';
    }
    renderModels(config.models);
    if (!config.devices.some(d => d.id === selectedDevice)) selectedDevice = '';
    const devices = [{ id: '', name: 'System default (follows device changes)' }, ...config.devices];
    $('caption-device-options').replaceChildren();
    for (const d of devices) {
      choice($('caption-device-options'), 'caption-device', d.id, d.name, '', d.id === selectedDevice, false,
        () => { selectedDevice = d.id; localStorage.setItem('captionDevice', d.id); });
    }
    ready = config.models.some(m => m.installed) && !config.runtimeMissing;
    setStatus('Audio off');
    const suggested = config.models.find(m => m.recommended);
    if (config.runtimeMissing) notice('Caption components are missing. Reinstall the app.');
    else if (!config.models.some(m => m.installed)) {
      $('caption-settings').open = true;
      notice(`Download a speech model to start captions${suggested ? `; ${suggested.name} is suggested for this PC` : ''}.`);
    } else if (config.deviceError) notice(config.deviceError);
  }

  // Start or stop listening. Shared by the Captions tab button and the
  // ChatGPT tab's start/stop toggle so either one controls the same worker.
  async function toggleCaptions() {
    if (active) {
      setStatus('Finishing…', 'stopping');
      try { await window.privacy.stopCaptions(); }
      catch { notice('Could not stop the caption worker.'); setStatus('Audio off'); }
      return;
    }
    notice();
    $('caption-settings')?.removeAttribute('open');
    setStatus('Starting…', 'starting');
    try {
      const result = await window.privacy.startCaptions({ profile: selectedProfile, device: selectedDevice });
      if (!result.started) { notice(result.error || 'Could not start local captions.'); setStatus('Audio off'); }
    } catch { notice('Could not start local captions.'); setStatus('Audio off'); }
  }
  $('start-captions').addEventListener('click', toggleCaptions);
  $('chat-start-captions').addEventListener('click', toggleCaptions);

  $('clear-captions').addEventListener('click', () => {
    lines.clear();
    $('caption-transcript').replaceChildren();
    document.dispatchEvent(new CustomEvent('caption:cleared'));
  });

  window.privacy.onCaptionsEvent(event => {
    if (event.type === 'status') {
      setStatus(event.message || 'Listening · Offline', event.state || 'running');
    } else if (event.type === 'model') {
      showModelProgress(event);
    } else if (event.type === 'notice') {
      notice(event.message);
    } else if (event.type === 'source') {
      $('caption-source').textContent = event.name;
    } else if (event.type === 'level') {
      $('caption-meter').value = Math.max(0, Math.min(60, event.db + 60));
    } else if (event.type === 'metrics') {
      const seconds = (event.processingMs / 1000).toFixed(1);
      const delay = event.behindMs > 4000 ? ` · Processing is ${(event.behindMs / 1000).toFixed(1)}s behind; try a faster engine` : '';
      $('caption-performance').textContent = `English · Audio stays on this PC · Last update processed in ${seconds}s${delay}`;
    } else if (event.type === 'partial' || event.type === 'final') {
      const transcript = $('caption-transcript');
      let line = lines.get(event.id);
      // A revision only updates a line still shown (not cleared or trimmed).
      if (event.revision && !line) return;
      if (!event.text) {
        if (line) line.remove();
        lines.delete(event.id);
        return;
      }
      // Forward every caption update (interim + final) so the ChatGPT composer
      // can mirror the live transcript with the same latency as this tab, not
      // only once a phrase finalizes.
      document.dispatchEvent(new CustomEvent('caption:update', {
        detail: { id: event.id, text: event.text, type: event.type, revision: Boolean(event.revision) },
      }));
      const follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
      if (transcript.querySelector('.caption-placeholder')) transcript.replaceChildren();
      if (!line) {
        line = document.createElement('p');
        line.dataset.captionId = event.id;
        transcript.append(line);
        lines.set(event.id, line);
      }
      line.className = `caption-line${event.type === 'partial' ? ' partial' : ''}`;
      line.textContent = event.text;
      while (transcript.children.length > 100) {
        lines.delete(transcript.firstElementChild.dataset.captionId);
        transcript.firstElementChild.remove();
      }
      if (follow) transcript.scrollTop = transcript.scrollHeight;
    } else if (event.type === 'error') {
      notice(event.message || 'Local captions stopped.');
    } else if (event.type === 'stopped') {
      setStatus('Audio off');
      // A killed inference worker may leave an unfinished hypothesis.
      for (const line of lines.values()) {
        if (line.classList.contains('partial')) line.classList.add('interrupted');
      }
    }
  });
  configure().catch(() => { notice('Caption setup could not be read. Restart the application.'); });
})();
