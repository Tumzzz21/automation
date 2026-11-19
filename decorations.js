// Keep decorative platform lights static on phones without changing desktop visuals or queue feedback.
if (typeof mobileOverlayDevice === 'function' && mobileOverlayDevice()) {
  const mobileStyle = document.createElement('style');
  mobileStyle.textContent = '.platform-field::after{animation:none;filter:none}';
  document.head.append(mobileStyle);
}

// Static visual accents stay relative to the entire panel card.
document.querySelectorAll('section.card').forEach(card => {
  for (const color of ['violet']) {
    const accent = document.createElement('span');
    accent.className = `card-accent ${color}`;
    accent.setAttribute('aria-hidden', 'true');
    card.append(accent);
  }
});
