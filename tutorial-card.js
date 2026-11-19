// Video tutorial (owner 2026-10-31): a one-time "New to 0xFlow?" card at the top of Control, and a "Watch tutorial"
// item in the ⚙ menu that stays after the card is gone. The card hides for good once it is clicked or closed.
(() => {
  const URL = 'https://youtu.be/W-24LaX1r9Q', KEY = 'tutorialCardDone';
  const card = document.getElementById('tutorialCard');
  const openVideo = () => { if (globalThis.chrome?.tabs?.create) chrome.tabs.create({url: URL}); else window.open(URL, '_blank', 'noopener'); };
  const done = () => { if (card) card.hidden = true; try { chrome.storage.local.set({[KEY]: true}); } catch { /* the card just shows again next time */ } };
  document.getElementById('tutorialCardOpen')?.addEventListener('click', () => { done(); openVideo(); });
  document.getElementById('tutorialCardClose')?.addEventListener('click', done);
  // The menu closes itself (update-notice.js ignores actions it does not know).
  document.getElementById('headerAccountMenu')?.addEventListener('click', event => {
    if (event.target.closest?.('[data-header-action="tutorial"]')) openVideo();
  });
  if (!card) return;
  Promise.resolve().then(() => chrome.storage.local.get(KEY)).then(saved => { card.hidden = !!saved?.[KEY]; }, () => { card.hidden = false; });
})();
