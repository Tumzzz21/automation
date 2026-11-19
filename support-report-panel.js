// Explicit preview -> Send -> optional Apply fix. No background reporting.
(() => {
  'use strict';
  function mount({document, data, snapshot, request, applySettings, getSettings, writeLog}) {
    const el = id => document.getElementById(id), dialog = el('supportReportDialog');
    let report = null, fix = null, epoch = 0, sending = false;
    const status = message => { el('supportReportStatus').textContent = message; };
    function preview() {
      report = {...report, note: data.line(el('supportReportNote').value)};
      el('supportReportPreview').textContent = JSON.stringify(report, null, 2);
    }
    function close() { epoch++; report = fix = null; sending = false; dialog.close(); }
    el('sendSupportBtn').addEventListener('click', () => {
      epoch++; fix = null; sending = false;
      report = data.cleanReport(snapshot()); el('supportReportNote').value = '';
      el('supportReportNote').disabled = false; el('supportReportSend').disabled = false;
      el('supportReportApply').hidden = true; el('supportReportChanges').replaceChildren(); el('supportReportCancel').textContent = 'Close';
      status('Nothing is sent until you press Send.');
      preview(); if (!dialog.open) dialog.showModal();
    });
    el('supportReportNote').addEventListener('input', () => { if (report && !sending) preview(); });
    el('supportReportCancel').addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    el('supportReportSend').addEventListener('click', async () => {
      if (!report || sending || el('supportReportSend').disabled) return;
      preview();
      const payload = JSON.parse(JSON.stringify(report)), turn = epoch;
      sending = true; el('supportReportSend').disabled = true; el('supportReportNote').disabled = true;
      status('Sending… the assistant is reading your report (up to 30 seconds).');
      try {
        const answer = await request(payload);
        if (turn !== epoch) return;
        const changes = data.allowedChanges(answer.changes || {}), current = getSettings();
        const old = Object.fromEntries(Object.keys(changes).map(key => [key, current[key]]));
        // Say plainly that it arrived (owner 2026-11-15: the answer alone did not read as a confirmation).
        const ref = /^[0-9a-f-]{8,}$/i.test(String(answer.id || '')) ? ' (report ' + String(answer.id).slice(0, 8) + ')' : '';
        status('✓ Report sent' + ref + '. ' + data.redact(String(answer.answer || 'Thanks, the team will look at it')).slice(0, 2000));
        for (const [key, value] of Object.entries(changes)) {
          const item = document.createElement('li');
          item.textContent = `${key}: ${data.line(old[key] ?? '(unset)')} → ${data.line(value)}`;
          el('supportReportChanges').append(item);
        }
        fix = Object.keys(changes).length ? {changes, old} : null;
        el('supportReportApply').hidden = !fix; el('supportReportApply').disabled = false;
        // Keep Send disabled after success: closing/reopening starts a new report.
      } catch (error) {
        if (turn !== epoch) return;
        status(error.status === 429 ? 'You have sent 5 support reports today. Try again tomorrow.' :
          error.status === 401 ? 'Sign in to 0xFlow, then reopen this preview to send your report.' :
          'The report could not be confirmed. Try again later; it may already have arrived.');
      } finally { if (turn === epoch) sending = false; }
    });
    el('supportReportApply').addEventListener('click', async () => {
      if (!fix || el('supportReportApply').disabled) return;
      const turn = epoch, pending = fix, current = getSettings();
      if (Object.keys(pending.old).some(key => current[key] !== pending.old[key])) {
        status('Settings changed since the suggestion. Reopen the preview for a fresh report.'); return;
      }
      el('supportReportApply').disabled = true;
      try {
        const message = await applySettings(data.allowedChanges(pending.changes));
        if (turn !== epoch) return;
        writeLog('Support fix previous values: ' + Object.entries(pending.old).map(([key, value]) => key + '=' + data.line(value ?? '(unset)')).join('; ') + '.');
        // Tell the member what to do now (owner 2026-11-15: after Apply fix it was unclear what comes next).
        status('✓ Fix applied. ' + data.redact(String(message)).slice(0, 1500) +
          ' Next: press Close, then press Start again (or Retry on the prompts that failed). The old values are saved in Debug logs if you want to change them back.');
        el('supportReportCancel').textContent = 'Close and continue'; fix = null;
      } catch {
        if (turn === epoch) status('The fix could not be applied. Stop any running queue and check the panel settings.');
      } finally { if (turn === epoch) el('supportReportApply').disabled = !fix; }
    });
  }
  async function sendReport(report) {
    const config = await chrome.storage.local.get(['remoteRepairUrl', 'remoteRepairToken']);
    if (!config.remoteRepairToken) throw Object.assign(Error('Sign in required'), {status: 401});
    const base = remoteRepairBase(config.remoteRepairUrl);
    const response = await (typeof repairFetch === 'function' ? repairFetch : fetch)(base + '/support/report', {method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(60000), headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + config.remoteRepairToken},
      body: JSON.stringify(report)});
    if (!response.ok) throw Object.assign(Error('Support request failed'), {status: response.status});
    return response.json();
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {mount, sendReport};
  else if (document.getElementById('sendSupportBtn')) mount({document, data: globalThis.SupportReportData,
    snapshot: () => ({version: APP_VERSION, platform: settings.platform || 'flow', settings, logs}),
    request: sendReport, getSettings: () => settings,
    applySettings: changes => window.flowMcpBridge.setSettings(changes), writeLog: message => log(message)});
})();
