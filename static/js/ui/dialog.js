/* ─── ui/dialog ────────────────────────────────────────────────
   Подтверждения в оформлении приложения вместо системного confirm().

   ЗАЧЕМ. Браузерное окно выглядит чужим: заголовок «Подтвердите действие
   на 127.0.0.1:8765», системные кнопки, своя типографика. Внутри
   приложения, где всё остальное нарисовано в одном стиле, оно читается
   как сбой, а не как вопрос.

   Оформление взято с оверлея проводника на этапе 01 (.seg-picker):
   затемнение с размытием, карточка по центру, те же радиусы и рамки.
   Третий стиль диалогов заводить незачем.

   API возвращает Promise — вызывающий код пишется так же, как с
   confirm(), только с await:

       if (!await Dialog.confirm({ text: '…' })) return;

   Esc и клик мимо отменяют, Enter подтверждает. Фокус ставится на
   кнопку отмены: подтверждаемые действия здесь разрушительные, и
   случайный Enter не должен их выполнять.
──────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  function css() {
    if (document.getElementById('ui-dialog-css')) return;
    const st = document.createElement('style');
    st.id = 'ui-dialog-css';
    st.textContent = [
      '.ui-dlg{position:fixed;inset:0;z-index:200;display:flex;align-items:center;',
      '  justify-content:center;background:rgba(8,12,20,.55);backdrop-filter:blur(3px);',
      '  padding:2vh 2vw;box-sizing:border-box}',
      'body.light-theme .ui-dlg{background:rgba(230,238,247,.6)}',
      '.ui-dlg-box{width:min(420px,92%);background:var(--card-solid,#0b1220);',
      '  color:var(--tx1,#c8e6ff);border:1px solid var(--brd,rgba(0,240,255,.18));',
      '  border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.4);',
      '  padding:22px 24px;box-sizing:border-box}',
      'body.light-theme .ui-dlg-box{background:#fff;color:#1a2b3c;border-color:#d0dde8}',
      '.ui-dlg-title{font-weight:700;font-size:15px;letter-spacing:.04em;',
      '  text-transform:uppercase;color:var(--accent,#4F7CDB);margin:0 0 10px;',
      '  padding-left:9px;border-left:3px solid var(--accent,#4F7CDB)}',
      '.ui-dlg-text{font-size:13.5px;line-height:1.6;margin:0 0 18px;',
      '  color:var(--tx2,#5b6b80)}',
      '.ui-dlg-text b{color:inherit;font-weight:600}',
      '.ui-dlg-btns{display:flex;gap:8px;justify-content:flex-end}',
      '.ui-dlg-btns button{padding:8px 16px;border-radius:8px;font:inherit;',
      '  font-size:13px;cursor:pointer;border:1px solid var(--brd,#dfe4ec);',
      '  background:transparent;color:var(--tx2,#5b6b80);transition:.12s}',
      '.ui-dlg-btns button:hover{background:rgba(127,127,127,.09);',
      '  color:var(--tx1,#1f2a37)}',
      '.ui-dlg-btns button.primary{border-color:var(--accent,#4F7CDB);',
      '  color:var(--accent,#4F7CDB);font-weight:600}',
      '.ui-dlg-btns button.primary:hover{background:rgba(79,124,219,.10)}',
      /* Разрушительное действие — красным. Врач должен видеть разницу
         между «продолжить» и «стереть работу» до нажатия, а не после. */
      '.ui-dlg-btns button.danger{border-color:rgba(229,72,77,.5);color:#e5484d}',
      '.ui-dlg-btns button.danger:hover{background:rgba(229,72,77,.10)}',
    ].join('');
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* opts: { title, text, ok, cancel, danger }
     text можно передать с уже готовой разметкой через opts.html. */
  function confirm(opts) {
    opts = opts || {};
    css();
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'ui-dlg';
      ov.innerHTML =
        '<div class="ui-dlg-box" role="dialog" aria-modal="true">' +
          '<div class="ui-dlg-title">' + esc(opts.title || 'Подтвердите') + '</div>' +
          '<div class="ui-dlg-text">' + (opts.html || esc(opts.text || '')) + '</div>' +
          '<div class="ui-dlg-btns">' +
            '<button type="button" data-r="0">' + esc(opts.cancel || 'Отмена') + '</button>' +
            '<button type="button" data-r="1" class="' +
              (opts.danger ? 'danger' : 'primary') + '">' +
              esc(opts.ok || 'Продолжить') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(ov);

      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        ov.remove();
        resolve(v);
      };
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
      };

      ov.addEventListener('click', e => {
        const b = e.target.closest('[data-r]');
        if (b) { finish(b.dataset.r === '1'); return; }
        if (e.target === ov) finish(false);      // клик мимо — отмена
      });
      document.addEventListener('keydown', onKey, true);

      /* Фокус на отмене: все подтверждения здесь разрушительные, и
         случайный Enter не должен стирать работу. */
      const cancelBt = ov.querySelector('[data-r="0"]');
      if (cancelBt) cancelBt.focus();
    });
  }

  global.Dialog = { confirm };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.Dialog;
})(typeof window !== 'undefined' ? window : globalThis);
