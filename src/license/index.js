'use strict';
// Zovo Pro facade (factory/sprint/license/index.js, lane PAY1). Copy this folder's index.js, license.js and
// sponsors.js to src/license/ in an extension, unchanged. Contract and rails: API.md.
//
// One object for the extension: isPro(sku) is true when ANY rail says so (GitHub Sponsors, offline license key,
// later Polar). isPro reads local caches only: no network at activation, on file open or in isPro.
// Network happens only after a user click: a rail's unlock() (GitHub sign-in + one GraphQL call for Sponsors;
// the key rail never uses the network) and "Get Pro", which opens a page in the browser. No telemetry.
//
//   const { createLicense } = require('./license');
//   const pro = createLicense({ vscode, context, sku: 'hex-pro', name: 'Hex Viewer', commandPrefix: 'hexViewer' });
//   await pro.ready;
//   pro.isPro('hex-pro');                          // sync
//   if (await pro.requirePro('Binary templates')) runIt();   // explains + offers unlock when locked
//
// Commands (registered when commandPrefix is set; list them in package.json, see README.md):
//   <prefix>.enterLicenseKey   "Zovo: Enter license key"
//   <prefix>.getPro            "Zovo: Get Pro"
//   <prefix>.unlockWithSponsors "Zovo: Unlock Pro with GitHub Sponsors"   (only when the Sponsors rail is present)
//   <prefix>.removeLicense     "Zovo: Remove license from this editor"
//   <prefix>.payWithPayPal     "Zovo: Pay for Pro with PayPal"   (CONV2; only when a PayPal link is set)
//
// CONV2 (9 Nov): the buy path. Get Pro and Pay with PayPal open the browser and arm ONE "back from the browser"
// message the next time the editor window gets focus again (within 2 h, only when still not Pro): it offers the
// GitHub unlock or the PayPal transaction-id form. PayPal: USD 19 (one person) or USD 59 (team of 5), the
// transaction id goes to the zovo-pro-key issue form, the key comes by email.

const crypto = require('crypto');
const { createKeyRail, INSTALL_ID_KEY } = require('./license');

// The Zovo Pro tier ("$19 one time", tier_id 679878) on GitHub Sponsors. Not the generic one-time page: that page also
// lists the notemods.com Obsidian tiers, which do not include Zovo Pro.
const SPONSORS_ONE_TIME = 'https://github.com/sponsors/theluckystrike/sponsorships?tier_id=679878';
// PayPal: the amount and currency are in the link (the account's main currency is USD; the suffix makes it explicit).
const PAYPAL_ME = 'https://www.paypal.com/paypalme/najzzz';
const PRICE = { one: 19, team: 59, seats: 5 };
// The public issue form where a PayPal buyer sends the transaction id (owner watches it; the key goes by email).
const KEY_REQUEST_URL = 'https://github.com/theluckystrike/zovo-plugin-factory/issues/new?template=zovo-pro-key.yml';
const RETURN_MS = 2 * 60 * 60 * 1000;
const PAYPAL_LABEL = 'Pay with PayPal';
const LABELS = {
  'github-sponsors': 'Unlock with GitHub Sponsors',
  'license-key': 'I have a license key',
  polar: 'Unlock with a Polar key',
};

function defaultSponsorsRail(vscode, context) {
  try {
    // eslint-disable-next-line global-require
    const { createSponsorsRail } = require('./sponsors');
    return createSponsorsRail({ vscode, context });
  } catch (e) {
    return null; // product ships without the Sponsors rail
  }
}

// Options:
//   vscode, context, sku ("hex-pro"), name ("Hex Viewer")
//   rails          optional array of rails (API.md). Default: [GitHub Sponsors (if sponsors.js is present), license key]
//   paymentUrl     optional buy page for "Get Pro". Default: the GitHub Sponsors one-time page (Stripe is not
//                  available to the seller; see out/PAY1.md). For the Stripe rail use BUY_URL + sku from license.js.
//                  '' = not on sale: Get Pro shows a message and opens nothing.
//   commandPrefix  registers the commands above
//   product        product name for the PayPal form, e.g. "Hex Viewer" (default: name)
//   paypalUrl      PayPal.me base link (default PAYPAL_ME). '' = no PayPal option
//   keyRequestUrl  where a PayPal buyer sends the transaction id (default KEY_REQUEST_URL)
//   howToBuy       false = do not add the "How to buy" paragraph to the requirePro explanation
//   publicKey, now, allowTest   passed to the key rail (tests only)
function createLicense(o) {
  const { vscode, context, sku } = o;
  const name = o.name || 'Zovo';
  const label = `${name} Pro`;
  const keyRail = createKeyRail({ vscode, context, sku, name, publicKey: o.publicKey, now: o.now, allowTest: o.allowTest });
  const rails = (o.rails || [defaultSponsorsRail(vscode, context), keyRail]).filter(Boolean);
  const byId = (id) => rails.find((r) => r.id === id);
  const paymentUrl = o.paymentUrl === undefined ? SPONSORS_ONE_TIME : o.paymentUrl;
  const paypalUrl = (o.paypalUrl === undefined ? PAYPAL_ME : o.paypalUrl || '').replace(/\/+$/, '');
  const keyRequestUrl = o.keyRequestUrl === undefined ? KEY_REQUEST_URL : o.keyRequestUrl;
  const product = o.product || name;
  const sponsorsRail = () => byId('github-sponsors');
  const onSponsors = () => paymentUrl === SPONSORS_ONE_TIME || /^https:\/\/github\.com\/sponsors\//.test(paymentUrl);
  const listeners = new Set();
  let last = null;

  const isPro = (s) => rails.some((r) => { try { return r.isPro(s || sku); } catch (e) { return false; } });
  function changed() {
    const now = isPro();
    if (now === last) return;
    last = now;
    for (const fn of listeners) { try { fn(now); } catch (e) { /* listener error */ } }
  }
  for (const r of rails) if (typeof r.onDidChange === 'function') r.onDidChange(changed);

  function installId() {
    let id = context.globalState.get(INSTALL_ID_KEY);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      id = crypto.randomUUID();
      context.globalState.update(INSTALL_ID_KEY, id);
    }
    return id;
  }

  const open = (url) => vscode.env.openExternal(vscode.Uri.parse(url, true));

  // Opens the buy page. A Stripe Payment Link (or /buy/<sku>) gets client_reference_id = a random install id,
  // so a support request can be matched to a checkout. Nothing about the user or machine is sent.
  async function getPro() {
    if (!paymentUrl) {
      await vscode.window.showInformationMessage(`${label} is not on sale yet. Everything you use today stays free.`);
      return false;
    }
    if (/^https:\/\/(buy\.stripe\.com|license(-test)?\.zovo\.one)\//.test(paymentUrl)) {
      const sep = paymentUrl.includes('?') ? '&' : '?';
      return open(`${paymentUrl}${sep}client_reference_id=${encodeURIComponent(installId())}`);
    }
    return openArmed(paymentUrl, onSponsors() && sponsorsRail() ? 'sponsors' : '');
  }

  // ---- back from the browser (CONV2) ----
  // One message, the first time the window is focused again after the browser took the focus, within 2 h of the
  // click, only while still not Pro. It continues the purchase the user started; it never repeats.
  let pending = null;
  let winSub = null;
  function armReturn(kind) {
    const w = vscode.window;
    if (!w || typeof w.onDidChangeWindowState !== 'function') return;
    pending = { kind, at: Date.now(), blurred: !!(w.state && w.state.focused === false) };
    if (!winSub) {
      winSub = w.onDidChangeWindowState((e) => { onWindow(e).catch(() => {}); });
      if (context.subscriptions && winSub) context.subscriptions.push(winSub);
    }
  }
  // Arm first, then open: the browser can take the focus before openExternal resolves. A failed open disarms.
  async function openArmed(url, kind) {
    if (kind) armReturn(kind);
    try { return await open(url); } catch (e) { if (kind) pending = null; throw e; }
  }
  async function onWindow(e) {
    if (!pending) return;
    if (Date.now() - pending.at > RETURN_MS) { pending = null; return; }
    if (!e || !e.focused) { pending.blurred = true; return; }
    if (!pending.blurred) return;
    const kind = pending.kind;
    pending = null;
    if (isPro()) return;
    if (kind === 'sponsors') {
      const u = LABELS['github-sponsors'];
      const pick = await vscode.window.showInformationMessage(`Back from GitHub Sponsors? If you paid for the "$${PRICE.one} one time" tier, turn ${label} on now: VS Code asks you to sign in with GitHub.`, u, 'Not yet');
      if (pick === u) await unlock('github-sponsors');
    } else if (kind === 'paypal') {
      const send = 'Send the transaction ID', key = LABELS['license-key'];
      const pick = await vscode.window.showInformationMessage(`Back from PayPal? Send the transaction ID from your PayPal receipt. The ${label} license key then comes to the email address of your PayPal account.`, send, key);
      if (pick === send) await sendTransactionId();
      else if (pick === key) await unlock('license-key');
    }
  }

  function keyRequestLink() {
    if (!keyRequestUrl) return '';
    const sep = keyRequestUrl.includes('?') ? '&' : '?';
    return `${keyRequestUrl}${sep}title=${encodeURIComponent(`Zovo Pro key: PayPal payment for ${product}`)}&product=${encodeURIComponent(product)}`;
  }

  async function sendTransactionId() {
    const link = keyRequestLink();
    if (!link) return false;
    await open(link);
    return true;
  }

  // PayPal (CONV2): the steps in one modal the user started. The owner checks the payment and emails the key.
  async function payWithPayPal() {
    if (!paypalUrl) {
      await vscode.window.showInformationMessage(`${label} is not sold by PayPal in this version.`);
      return false;
    }
    const one = `Pay USD ${PRICE.one} on PayPal`;
    const team = `Team of ${PRICE.seats}: USD ${PRICE.team}`;
    const send = 'Send the transaction ID';
    const key = LABELS['license-key'];
    const buttons = [one, team];
    if (keyRequestUrl) buttons.push(send);
    buttons.push(key);
    const steps = [
      `1. Pay USD ${PRICE.one} for one person, or USD ${PRICE.team} for a team of ${PRICE.seats} (one key for ${PRICE.seats} people). PayPal opens in your browser with the amount filled in.`,
      keyRequestUrl
        ? '2. Copy the transaction ID from the PayPal receipt (17 letters and digits) and send it with "Send the transaction ID", a short form on GitHub. Post only the ID, never your name or email. No GitHub account? Write "Zovo Pro" in the PayPal note instead.'
        : '2. Write "Zovo Pro" in the PayPal note.',
      `3. The license key comes to the email address of your PayPal account. Paste it with "${key}". It is checked on your computer and works for life in every Zovo viewer.`,
    ];
    const pick = await vscode.window.showInformationMessage(`Pay for ${label} with PayPal`, { modal: true, detail: steps.join('\n\n') }, ...buttons);
    if (pick === one || pick === team) {
      await openArmed(`${paypalUrl}/${pick === one ? PRICE.one : PRICE.team}USD`, 'paypal');
      return false;
    }
    if (pick === send) { await sendTransactionId(); return false; }
    if (pick === key) return !!(await unlock('license-key')).pro && isPro();
    return false;
  }

  // The short "how to buy" paragraph for the requirePro explanation.
  function howToBuy() {
    const parts = [];
    if (paymentUrl && onSponsors()) parts.push(`"Get ${label}" opens the "$${PRICE.one} one time" tier on GitHub Sponsors. After you pay, come back and choose "${LABELS['github-sponsors']}".`);
    else if (paymentUrl) parts.push(`"Get ${label}" opens the checkout page in your browser.`);
    if (paypalUrl) parts.push(`"${PAYPAL_LABEL}": USD ${PRICE.one}, or USD ${PRICE.team} for a team of ${PRICE.seats}; the license key comes by email.`);
    return parts.length ? `How to buy: ${parts.join(' ')}` : '';
  }

  // Run one rail's unlock and show its message. Returns the UnlockResult.
  async function unlock(railId) {
    let rail = railId ? byId(railId) : null;
    if (!rail && rails.length === 1) rail = rails[0];
    if (!rail) {
      const DESC = { 'github-sponsors': `you paid on GitHub Sponsors`, 'license-key': 'a key that starts with ZOVO1.' };
      const items = rails.map((r) => ({ label: r.label || LABELS[r.id] || r.id, description: DESC[r.id] || '', id: r.id }));
      if (paypalUrl) items.push({ label: PAYPAL_LABEL, description: `USD ${PRICE.one}, team of ${PRICE.seats} USD ${PRICE.team}, key by email`, id: 'paypal' });
      items.push({ label: `Get ${label}`, description: onSponsors() ? `USD ${PRICE.one} once on GitHub Sponsors` : '', id: 'buy' });
      const pick = await vscode.window.showQuickPick(items, { title: `Unlock ${label}`, placeHolder: 'How did you get Zovo Pro? Or buy it here.' });
      const none = () => ({ rail: '', pro: isPro(), reason: 'cancelled', kind: 'none', login: '', message: '' });
      if (!pick) return none();
      if (pick.id === 'buy') { await getPro(); return none(); }
      if (pick.id === 'paypal') { await payWithPayPal(); return { ...none(), pro: isPro() }; }
      rail = byId(pick.id);
    }
    const r = await rail.unlock();
    if (r && r.message) {
      if (r.pro) await vscode.window.showInformationMessage(r.message);
      else if (r.reason === 'expired' && r.renewUrl) {
        if ((await vscode.window.showWarningMessage(r.message, 'Renew page')) === 'Renew page') await open(r.renewUrl);
      } else if (r.reason === 'not-sponsor' || r.reason === 'other-tier' || r.reason === 'below-minimum') {
        const btns = ['Open GitHub Sponsors'];
        if (paypalUrl) btns.push(PAYPAL_LABEL);
        const pick = await vscode.window.showWarningMessage(r.message, ...btns);
        if (pick === 'Open GitHub Sponsors') await openArmed(SPONSORS_ONE_TIME, 'sponsors');
        else if (pick === PAYPAL_LABEL) await payWithPayPal();
      } else if (rail.id === 'github-sponsors' && ['no-session', 'auth', 'scope'].includes(r.reason) && (paypalUrl || byId('license-key'))) {
        // No GitHub sign-in in this editor (or it failed): offer the ways that need no GitHub.
        const btns = [];
        if (paypalUrl) btns.push(PAYPAL_LABEL);
        if (byId('license-key')) btns.push(LABELS['license-key']);
        const pick = await vscode.window.showWarningMessage(`${r.message} You can also pay with PayPal and get a license key by email.`, ...btns);
        if (pick === PAYPAL_LABEL) await payWithPayPal();
        else if (pick === LABELS['license-key']) { changed(); return unlock('license-key'); }
      } else if (r.reason !== 'cancelled') await vscode.window.showWarningMessage(r.message);
    }
    changed();
    return r;
  }

  // For a Pro action the user started: true when unlocked. Otherwise one modal (user-started, so allowed by the
  // VS Code UX rules) that says what the feature is, with the unlock ways and Get Pro. Never shown on its own.
  async function requirePro(feature, detail) {
    if (isPro()) {
      for (const r of rails) if (typeof r.refresh === 'function') r.refresh().catch(() => {}); // due monthly recheck only
      return true;
    }
    // Buy first (Get Pro, PayPal), then "I already paid" (the rails), then Renew.
    const buttons = [`Get ${label}`];
    if (paypalUrl) buttons.push(PAYPAL_LABEL);
    buttons.push(...rails.map((r) => r.label || LABELS[r.id] || r.id));
    const renew = keyRail.renewUrl();
    if (renew) buttons.push('Renew page');
    const how = o.howToBuy === false ? '' : howToBuy();
    const body = detail || 'Everything you use today stays free. Pro adds tools for professional work.';
    const pick = await vscode.window.showInformationMessage(`${feature} is part of ${label}.`, {
      modal: true,
      detail: how ? `${body}\n\n${how}` : body,
    }, ...buttons);
    if (!pick) return false;
    if (pick === `Get ${label}`) { await getPro(); return false; }
    if (pick === PAYPAL_LABEL) return payWithPayPal();
    if (pick === 'Renew page') { await open(renew); return false; }
    const rail = rails.find((r) => (r.label || LABELS[r.id] || r.id) === pick);
    if (!rail) return false;
    return !!(await unlock(rail.id)).pro && isPro();
  }

  async function remove() {
    for (const r of rails) if (typeof r.remove === 'function') await r.remove();
    changed();
    await vscode.window.showInformationMessage(`${label} license removed from this editor. Free features keep working.`);
  }

  // vscode://<publisher.name>/license?key=ZOVO1... from the Stripe license page. Asks before it stores anything.
  async function handleUri(uri) {
    if (!uri || !/\/license\/?$/.test(uri.path || '')) return false;
    const key = new URLSearchParams(uri.query || '').get('key');
    if (!key) return false;
    const pick = await vscode.window.showInformationMessage(`Add a ${label} license key from the license page?`, { modal: true }, 'Add key');
    if (pick !== 'Add key') return false;
    const r = await keyRail.saveKey(key);
    if (r.pro) await vscode.window.showInformationMessage(r.message); else await vscode.window.showWarningMessage(r.message);
    changed();
    return r.pro;
  }

  function registerCommands(prefix) {
    const p = prefix || o.commandPrefix;
    const d = [
      vscode.commands.registerCommand(`${p}.enterLicenseKey`, () => unlock('license-key')),
      vscode.commands.registerCommand(`${p}.getPro`, () => getPro()),
      vscode.commands.registerCommand(`${p}.removeLicense`, () => remove()),
    ];
    if (byId('github-sponsors')) d.push(vscode.commands.registerCommand(`${p}.unlockWithSponsors`, () => unlock('github-sponsors')));
    if (paypalUrl) d.push(vscode.commands.registerCommand(`${p}.payWithPayPal`, () => payWithPayPal()));
    context.subscriptions.push(...d);
    return d;
  }

  const api = {
    ready: Promise.all(rails.map((r) => Promise.resolve(r.ready).catch(() => {}))).then(() => { last = isPro(); }),
    rails,
    isPro,
    unlock,
    getPro,
    payWithPayPal,
    sendTransactionId,
    requirePro,
    remove,
    handleUri,
    registerCommands,
    installId,
    refresh: () => Promise.all(rails.map((r) => (typeof r.refresh === 'function' ? r.refresh().catch(() => false) : false))),
    state: () => Object.fromEntries(rails.map((r) => [r.id, typeof r.state === 'function' ? r.state() : null])),
    onDidChange(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; },
  };
  if (o.commandPrefix) registerCommands(o.commandPrefix);
  return api;
}

module.exports = { createLicense, SPONSORS_ONE_TIME, PAYPAL_ME, PRICE, KEY_REQUEST_URL };
