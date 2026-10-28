(() => {
  const $ = id => document.getElementById(id);
  const lines = new Map();
  let active = false;
  let ready = false;
  let stopping = false;
  let busy = null;  // model being downloaded or speed-checked
  let autoStarted = false;  // the one-time automatic setup download has been kicked off
  let allowed = false;      // the tool is unlocked (signed in + approved/trial)
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

  // One model, chosen automatically — the user only sees an install prompt, never
  // a picker. `installed` hides the panel; `busyNow` turns the button into Cancel.
  function setInstallUI({ installed, note }) {
    const panel = $('caption-install');
    if (!panel) return;
    panel.hidden = !!installed;
    if (installed) return;
    if (note) $('caption-install-note').textContent = note;
  }

  async function prepareModel(id) {
    busy = id;
    notice();
    updateStart();
    setInstallUI({ installed: false, note: 'Preparing captions… starting setup.' });
    const result = await window.privacy.downloadModel(id);
    busy = null;
    await configure();
    if (!result.ok) {
      // There is no button to retry — keep setting up automatically.
      const prog = $('caption-install-progress'); if (prog) prog.hidden = true;
      setInstallUI({ installed: false, note: 'Connection issue — retrying automatically…' });
      autoStarted = false;
      setTimeout(() => { if (allowed) configure(); }, 10000);
    }
  }

  function showModelProgress(event) {
    const note = $('caption-install-note');
    const prog = $('caption-install-progress');
    if (!note || !prog) return;
    if (event.phase === 'download' || event.phase === 'verify') {
      prog.hidden = false;
      prog.value = event.total ? event.done / event.total : 0;
      note.textContent = event.phase === 'verify' ? 'Verifying… almost done.'
        : `Preparing captions… ${event.total ? Math.round((event.done / event.total) * 100) : 0}%`;
    } else if (event.phase === 'installed' || event.phase === 'checking') {
      prog.hidden = true;
      note.textContent = 'Finishing on-device setup…';
    } else if (event.phase === 'error') {
      prog.hidden = true;
      note.textContent = event.message;
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
    // Pick the single model automatically: an already-installed one, else the
    // recommended fit for this PC, else Parakeet. The user never chooses.
    const models = config.models || [];
    const chosen = models.find(m => m.installed)
      || models.find(m => m.recommended)
      || models.find(m => m.id === 'parakeet')
      || models[0];
    selectedProfile = chosen ? chosen.id : 'parakeet';
    const installed = !!(chosen && chosen.installed);

    if (!config.devices.some(d => d.id === selectedDevice)) selectedDevice = '';
    const devices = [{ id: '', name: 'System default (follows device changes)' }, ...config.devices];
    $('caption-device-options').replaceChildren();
    for (const d of devices) {
      choice($('caption-device-options'), 'caption-device', d.id, d.name, '', d.id === selectedDevice, false,
        () => { selectedDevice = d.id; localStorage.setItem('captionDevice', d.id); });
    }

    ready = installed && !config.runtimeMissing;
    setStatus('Audio off');

    if (config.runtimeMissing) {
      setInstallUI({ installed: true }); // nothing to download fixes this
      notice('Caption components are missing. Reinstall the app.');
    } else if (!installed) {
      if (!autoStarted && busy === null && allowed) {
        // First launch: set the caption engine up automatically — no button to click.
        autoStarted = true;
        setInstallUI({ installed: false, note: 'Preparing captions… one-time setup.' });
        notice('');
        prepareModel(selectedProfile);
      } else {
        setInstallUI({ installed: false, note: 'Preparing captions… one-time setup.' });
        notice('');
      }
    } else {
      setInstallUI({ installed: true });
      if (config.deviceError) notice(config.deviceError);
    }
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
  // Kick off the automatic caption-engine setup as soon as the tool is unlocked.
  if (window.auth) {
    window.auth.getState().then((s) => {
      allowed = !!(s && s.allowed);
      if (allowed) configure();
    }).catch(() => {});
    window.auth.onAuthState((s) => {
      const was = allowed;
      allowed = !!(s && s.allowed);
      if (allowed && !was) configure();
    });
  }

  configure().catch(() => { notice('Caption setup could not be read. Restart the application.'); });
})();
