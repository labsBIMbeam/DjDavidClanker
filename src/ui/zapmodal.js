import { h, clear } from './dom.js';
import { setImage } from '../lib/artwork.js';
import { openModal, toast } from './modal.js';
import { resolveRecipient, createInvoice, payInvoice, openWavlakeBoost } from '../lib/zap.js';

const PRESETS = [21, 210, 2100, 21000];

export function openZapDialog(track, settings) {
  let amount = settings.zapDefault || 210;
  let comment = '';
  let recipient = null;

  const status = h('div', { class: 'zap-status' }, 'Suche Lightning-Adresse des Artists…');
  const amountInput = h('input', {
    class: 'zap-amount', type: 'number', min: '1', step: '1', value: String(amount),
    'aria-label': 'Betrag in Sats',
    oninput: (e) => { amount = Math.max(1, parseInt(e.target.value, 10) || 0); },
  });
  const commentInput = h('input', {
    class: 'zap-comment', type: 'text', maxLength: '250',
    placeholder: 'Boost-Nachricht (optional)',
    'aria-label': 'Nachricht',
    oninput: (e) => { comment = e.target.value; },
  });

  const presets = h('div', { class: 'zap-presets' }, ...PRESETS.map((p) =>
    h('button', { class: 'btn btn-mini', onclick: () => { amount = p; amountInput.value = String(p); } }, `${p}`),
  ));

  const modeNote = h('div', { class: 'muted zap-mode' },
    settings.zapMode === 'nip57'
      ? 'Modus NIP-57: der Zap-Request (kind 9734) wird vom Host signiert und dabei auch an deine Relays gesendet.'
      : 'Modus LNURL-pay: keine Signatur, keine Nostr-Quittung. Die Nachricht geht als LNURL-Kommentar mit.',
  );

  const body = h('div', { class: 'zap-body' },
    h('div', { class: 'zap-track' },
      track.artworkUrl ? setImage(h('img', { alt: '' }), track.artworkUrl) : null,
      h('div', {}, h('div', { class: 'zap-title' }, track.title), h('div', { class: 'zap-artist' }, track.artist)),
    ),
    status,
    h('label', { class: 'lbl' }, 'Sats'),
    h('div', { class: 'zap-amount-row' }, amountInput, presets),
    h('label', { class: 'lbl' }, 'Nachricht'),
    commentInput,
    modeNote,
  );

  const dlg = openModal({
    title: '⚡ Value4Value Zap',
    body,
    actions: [
      { label: 'Abbrechen', onClick: (close) => close() },
      { label: 'Zap senden', primary: true, onClick: () => send() },
    ],
  });

  resolveRecipient(track)
    .then((rec) => {
      recipient = rec;
      if (!rec) {
        status.textContent = 'Kein Nostr-Profil für diesen Artist gefunden.';
        status.className = 'zap-status warn';
      } else if (!rec.lnurl) {
        status.textContent = `${rec.name || track.artist}: keine Lightning-Adresse im Profil.`;
        status.className = 'zap-status warn';
      } else {
        status.textContent = `An ${rec.name || track.artist} · ${rec.address || 'LNURL'}`;
        status.className = 'zap-status ok';
      }
    })
    .catch((e) => {
      status.textContent = `Empfänger nicht auflösbar: ${e.message}`;
      status.className = 'zap-status warn';
    });

  async function send() {
    status.textContent = 'Erzeuge Invoice…';
    status.className = 'zap-status busy';
    try {
      const { invoice, mode } = await createInvoice(track, {
        amountSats: amount,
        comment,
        mode: settings.zapMode,
        recipient,
      });
      showInvoice(invoice, mode);
    } catch (e) {
      status.textContent = e.message;
      status.className = 'zap-status bad';
      if (e.code === 'NO_LNURL') {
        clear(status).appendChild(h('span', {}, e.message, ' '));
        status.appendChild(h('button', {
          class: 'btn btn-mini',
          onclick: () => openWavlakeBoost(track),
        }, 'Auf Wavlake boosten'));
      }
    }
  }

  function showInvoice(invoice, mode) {
    const ta = h('textarea', { class: 'invoice', readonly: true, rows: '4', value: invoice });
    dlg.setBody(h('div', { class: 'zap-body' },
      h('div', { class: 'zap-status ok' }, `Invoice über ${amount} sats erzeugt (${mode === 'nip57' ? 'NIP-57 Zap' : 'LNURL-pay'}).`),
      ta,
      h('div', { class: 'zap-invoice-actions' },
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const res = await payInvoice(invoice);
            if (res.ok) toast(res.method === 'webln' ? 'Bezahlt.' : 'Wallet geöffnet.', 'ok');
            else toast('Zahlung nicht bestätigt.', 'warn');
          },
        }, 'Im Wallet öffnen'),
        h('button', {
          class: 'btn btn-ghost',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(invoice);
              toast('Invoice kopiert.', 'ok');
            } catch {
              ta.select();
              toast('Kopieren blockiert — Text ist markiert.', 'warn');
            }
          },
        }, 'Kopieren'),
      ),
    ));
  }
}
