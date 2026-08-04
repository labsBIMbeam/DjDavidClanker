import { h, clear } from './dom.js';
import { setImage } from '../lib/artwork.js';
import { openModal, toast } from './modal.js';
import { resolveRecipient, createInvoice, payInvoice, openWavlakeBoost } from '../lib/zap.js';

const PRESETS = [21, 210, 2100, 21000];

export function openZapDialog(track, settings) {
  let amount = settings.zapDefault || 210;
  let comment = '';
  let recipient = null;

  const status = h('div', { class: 'zap-status' }, 'Looking up the artist\'s Lightning address…');
  const amountInput = h('input', {
    class: 'zap-amount', type: 'number', min: '1', step: '1', value: String(amount),
    'aria-label': 'Amount in sats',
    oninput: (e) => { amount = Math.max(1, parseInt(e.target.value, 10) || 0); },
  });
  const commentInput = h('input', {
    class: 'zap-comment', type: 'text', maxLength: '250',
    placeholder: 'Boost message (optional)',
    'aria-label': 'Message',
    oninput: (e) => { comment = e.target.value; },
  });

  const presets = h('div', { class: 'zap-presets' }, ...PRESETS.map((p) =>
    h('button', { class: 'btn btn-mini', onclick: () => { amount = p; amountInput.value = String(p); } }, `${p}`),
  ));

  const modeNote = h('div', { class: 'muted zap-mode' },
    settings.zapMode === 'nip57'
      ? 'NIP-57 mode: the zap request (kind 9734) is signed by the host and also published to your relays.'
      : 'LNURL-pay mode: no signature, no Nostr receipt. The message rides along as the LNURL comment.',
  );

  const body = h('div', { class: 'zap-body' },
    h('div', { class: 'zap-track' },
      track.artworkUrl ? setImage(h('img', { alt: '' }), track.artworkUrl) : null,
      h('div', {}, h('div', { class: 'zap-title' }, track.title), h('div', { class: 'zap-artist' }, track.artist)),
    ),
    status,
    h('label', { class: 'lbl' }, 'Sats'),
    h('div', { class: 'zap-amount-row' }, amountInput, presets),
    h('label', { class: 'lbl' }, 'Message'),
    commentInput,
    modeNote,
  );

  const dlg = openModal({
    title: '⚡ Value4Value Zap',
    body,
    actions: [
      { label: 'Cancel', onClick: (close) => close() },
      { label: 'Send zap', primary: true, onClick: () => send() },
    ],
  });

  resolveRecipient(track)
    .then((rec) => {
      recipient = rec;
      if (!rec) {
        status.textContent = 'No Nostr profile found for this artist.';
        status.className = 'zap-status warn';
      } else if (!rec.lnurl) {
        status.textContent = `${rec.name || track.artist}: no Lightning address in the profile.`;
        status.className = 'zap-status warn';
      } else {
        status.textContent = `To ${rec.name || track.artist} · ${rec.address || 'LNURL'}`;
        status.className = 'zap-status ok';
      }
    })
    .catch((e) => {
      status.textContent = `Could not resolve recipient: ${e.message}`;
      status.className = 'zap-status warn';
    });

  async function send() {
    status.textContent = 'Creating invoice…';
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
        }, 'Boost on Wavlake'));
      }
    }
  }

  function showInvoice(invoice, mode) {
    const ta = h('textarea', { class: 'invoice', readonly: true, rows: '4', value: invoice });
    dlg.setBody(h('div', { class: 'zap-body' },
      h('div', { class: 'zap-status ok' }, `Invoice for ${amount} sats created (${mode === 'nip57' ? 'NIP-57 zap' : 'LNURL-pay'}).`),
      ta,
      h('div', { class: 'zap-invoice-actions' },
        h('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            const res = await payInvoice(invoice);
            if (res.ok) toast(res.method === 'webln' ? 'Paid.' : 'Wallet opened.', 'ok');
            else toast('Payment not confirmed.', 'warn');
          },
        }, 'Open in wallet'),
        h('button', {
          class: 'btn btn-ghost',
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(invoice);
              toast('Invoice copied.', 'ok');
            } catch {
              ta.select();
              toast('Copy blocked — text is selected.', 'warn');
            }
          },
        }, 'Copy'),
      ),
    ));
  }
}
