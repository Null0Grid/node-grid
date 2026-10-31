// The "not secure" warning in front of plain http sites: CLOSE, PROCEED (don't
// trust), or PROCEED, I TRUST IT. The choice goes to Null Grid, which loads the site.
(() => {
  const N = window.nullgridInsecure, $ = (id) => document.getElementById(id);
  const info = N ? N.info() : null;
  $('addr').textContent = (info && info.url) || new URLSearchParams(location.search).get('url') || '';
  const pick = (c) => () => { if (N) N.choose(c); };
  $('close').onclick = pick('close');
  $('proceed').onclick = pick('proceed');
  $('trust').onclick = pick('trust');
  $('close').focus();
})();
