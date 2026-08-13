import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { fetchMessageTemplates } from '@/lib/api';
import { contextFromLead, renderTemplate } from '@/lib/template-render';
import { EmojiPicker } from '@/components/EmojiPicker';
import { formatRelative } from '@/lib/format';
import type { ConversationRow, MessageTemplateRow } from '@/lib/types';

// The one and only reply composer. Extracted verbatim from LeadDetailPage's
// ReplyBox so the inbox can reply in place without a second, drifting copy.
// Two rendering modes:
//   full    — the lead-page experience: conversation picker, emoji,
//             WhatsApp template picker.
//   compact — the inbox card: textarea + send only. The 24h-window status
//             line and the character counter stay in BOTH modes — they are
//             safety copy, not decoration.
export function ReplyComposer({
  disabled,
  onSend,
  sending,
  errorMessage,
  lead,
  channel = 'whatsapp',
  lastInboundAt,
  conversations = [],
  conversationId,
  onPickConversation,
  compact = false,
  autoFocus = false,
}: {
  disabled: boolean;
  onSend: (text: string) => Promise<unknown>;
  sending: boolean;
  errorMessage: string | null;
  // Needed only for template-variable rendering; the compact composer
  // (which hides the picker) may omit it.
  lead?: { full_name: string | null; phone: string | null; email: string | null; city: string | null };
  channel?: string;
  lastInboundAt?: string | null;
  conversations?: ConversationRow[];
  conversationId?: string;
  onPickConversation?: (id: string) => void;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [missingVars, setMissingVars] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const showTemplatePicker = !compact && channel !== 'instagram' && !!lead;
  const [pickerOpen, setPickerOpen] = useState(false);
  const templatesQ = useQuery({
    queryKey: ['templates', 'whatsapp', 'active'],
    queryFn: () => fetchMessageTemplates({ channel: 'whatsapp', status: 'active' }),
    enabled: pickerOpen && showTemplatePicker,
  });

  // 24h-window awareness: outside the window a WhatsApp reply goes out as
  // the fallback template, whose single body param holds 600 chars max.
  const windowOpen = channel !== 'instagram' && !!lastInboundAt &&
    Date.now() - Date.parse(lastInboundAt) < 24 * 60 * 60 * 1000;
  const templateMode = channel !== 'instagram' && !windowOpen;
  const overTemplateLimit = templateMode && text.length > 600;

  // The draft clears ONLY after a successful send — a failed send keeps
  // the operator's text (the old version wiped it on submit).
  async function send() {
    if (!text.trim() || disabled || sending) return;
    try {
      await onSend(text.trim());
      setText('');
      setMissingVars([]);
    } catch {
      // The mutation's onError already toasts; the draft stays put.
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void send();
  }

  // Caret-aware insertion — used by both the emoji picker and the
  // template picker (which used to WIPE whatever was already typed).
  function insertAtCaret(insert: string) {
    const el = textareaRef.current;
    if (!el) {
      setText((t) => t + insert);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const endPos = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + insert + text.slice(endPos);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + insert.length;
      el.setSelectionRange(caret, caret);
    });
  }

  function insertTemplate(template: MessageTemplateRow) {
    if (!lead) return;
    const ctx = contextFromLead(lead);
    const { text: rendered, missing } = renderTemplate(template.body, ctx);
    setMissingVars(missing);
    insertAtCaret(text.trim().length ? `\n${rendered}` : rendered);
    setPickerOpen(false);
  }

  const showConversationPicker = !compact && conversations.length > 1 && onPickConversation;

  return (
    <form onSubmit={submit} className={compact ? 'space-y-2' : 'mt-3 space-y-2'}>
      {showConversationPicker ? (
        <select
          className="kf-input w-full text-xs sm:w-auto"
          value={conversationId ?? ''}
          onChange={(e) => onPickConversation?.(e.target.value)}
          aria-label="בחירת שיחה לשליחה"
        >
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.channel === 'instagram' ? 'אינסטגרם' : 'וואטסאפ'} · פעילות אחרונה {formatRelative(c.last_activity_at)}
            </option>
          ))}
        </select>
      ) : null}
      <textarea
        ref={textareaRef}
        className={clsx('kf-input w-full', compact ? 'min-h-[56px]' : 'min-h-[88px]')}
        placeholder={disabled ? 'לא ניתן לשלוח (ליד מושתק או חסרה שיחה).' : 'הקלד תשובה ידנית... (Enter לשליחה, Shift+Enter לשורה חדשה)'}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
          }
        }}
        disabled={disabled}
      />
      {missingVars.length ? (
        <div className="kf-tone-warning rounded-md p-2 text-xs ring-1 ring-inset">
          שים לב: בתבנית חסרים נתונים לליד הזה — {missingVars.map((m) => `{{${m}}}`).join(', ')} יישלחו כפי שהם.
          מומלץ להשלים ידנית לפני שליחה.
        </div>
      ) : null}
      {overTemplateLimit ? (
        <div className="kf-tone-warning rounded-md p-2 text-xs ring-1 ring-inset">
          מחוץ לחלון 24 שעות: הלקוח יקבל כעת רק את 600 התווים הראשונים (כתבנית), והנוסח המלא
          יישלח אוטומטית כשיענה.
        </div>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {!compact ? <EmojiPicker disabled={disabled} onPick={insertAtCaret} /> : null}
          {showTemplatePicker ? (
            <button type="button" className="kf-btn text-xs" disabled={disabled}
              onClick={() => setPickerOpen((open) => !open)}>
              {pickerOpen ? 'סגור תבניות' : '+ הכנס תבנית'}
            </button>
          ) : null}
          <span className="text-slate-500">
            {channel === 'instagram'
              ? 'ייצא דרך אינסטגרם. מחוץ לחלון 24 שעות ההודעה תמתין עד שהלקוח יכתוב שוב.'
              : windowOpen
                ? 'ייצא דרך WhatsApp — חלון 24 השעות פתוח.'
                : 'ייצא דרך WhatsApp. מחוץ לחלון 24 שעות תישלח תבנית.'}
          </span>
          <span className={clsx('tabular-nums', text.length > 1800 ? 'text-amber-600' : 'text-slate-400')} dir="ltr">
            {text.length}/2000
          </span>
        </div>
        <button
          type="submit"
          className="kf-btn kf-btn-primary w-full sm:w-auto"
          disabled={disabled || sending || !text.trim()}
        >
          {sending ? 'שולח...' : 'שליחה'}
        </button>
      </div>
      {pickerOpen && showTemplatePicker ? (
        <div className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-2">
          {templatesQ.isLoading ? <p className="text-xs text-slate-500">טוען תבניות...</p> :
            templatesQ.data?.templates.length ? (
              <ul className="space-y-1">
                {templatesQ.data.templates.map((tpl) => (
                  <li key={tpl.id}>
                    <button type="button" className="w-full rounded-md p-2 text-right text-sm hover:bg-white"
                      onClick={() => insertTemplate(tpl)}>
                      <div className="font-medium">{tpl.name_he}</div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">{tpl.body}</div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-slate-500">אין תבניות פעילות. אפשר להוסיף ב-/templates.</p>}
        </div>
      ) : null}
      {errorMessage ? <p className="text-sm text-rose-600">{errorMessage}</p> : null}
    </form>
  );
}
