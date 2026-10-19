// The top-right "this site wants to..." prompt. Escape or Block = no.
(() => {
  const $ = (id) => document.getElementById(id);
  const ICONS = {
    location:      '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
    camera:        '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12"/><polygon points="16 10 22 7 22 17 16 14"/></svg>',
    microphone:    '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/></svg>',
    notifications: '<svg viewBox="0 0 24 24"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    screen:        '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    clipboard:     '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="14" height="17"/><rect x="9" y="2" width="6" height="4"/></svg>',
    other:         '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="17"/></svg>'
  };
  ICONS['camera+microphone'] = ICONS.camera;
  const VERBS = {
    location: 'wants to know your location',
    camera: 'wants to use your camera',
    microphone: 'wants to use your microphone',
    'camera+microphone': 'wants to use your camera and microphone',
    notifications: 'wants to show notifications',
    screen: 'wants to see your screen',
    clipboard: 'wants to read your clipboard',
    midi: 'wants to use MIDI devices',
    'external-app': 'wants to open an app on this PC',
    idle: 'wants to know when you are away',
    storage: 'wants to store data across sites',
    windows: 'wants to manage windows on your screens',
    speakers: 'wants to choose your speakers'
  };

  let open = false;
  const answer = (allow) => {
    if (!open) return;
    open = false;
    $('card').hidden = true;
    window.perm.answer(allow, $('remember').checked);
  };

  window.perm.onShow(({ host, kind }) => {
    $('icon').innerHTML = ICONS[kind] || ICONS.other;
    $('icon').className = 'badge k-' + String(kind).replace(/[^a-z]/g, '');
    $('host').textContent = host;
    $('what').textContent = VERBS[kind] || `wants permission: ${kind}`;
    $('remember').checked = false;
    $('card').hidden = false;
    open = true;
    $('block').focus();          // Enter on a fresh prompt never grants anything
  });
  $('allow').onclick = () => answer(true);
  $('block').onclick = () => answer(false);
  window.perm.onEscape(() => answer(false));
})();
