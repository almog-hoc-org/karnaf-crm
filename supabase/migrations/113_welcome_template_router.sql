-- 113_welcome_template_router.sql
--
-- The WhatsApp entry menu becomes the approved karnaf_landing_welcome_v1
-- template (3 quick-reply buttons: course / investor mentorship / human
-- rep) instead of the plain-text numbered prompt. Button taps arrive as
-- inbound button messages and are matched by the router.
--
-- 1) followup_text: an optional per-option message the bot sends right
--    after routing (e.g. the investors division wa.me short link).
-- 2) match_terms updated to the exact button titles. The old 'ליווי'
--    term is REMOVED from the program option — the investors button
--    title ("ליווי משקיעים פרימיום 1:1") contains it, and the program
--    option sorts first, so it hijacked investor taps.

alter table public.whatsapp_router_options
  add column if not exists followup_text text;

insert into public.whatsapp_router_options
  (option_key, display_order, label_he, match_terms, track, stage, interest_topic, followup_text)
values
  (
    'program', 10,
    'קורס הנדל"ן המקיף בישראל',
    array[
      '1', 'קורס', 'תכנית', 'תוכנית', 'דרך לדירה',
      'לקורס הנדל"ן המקיף בישראל', 'לקורס הנדל״ן המקיף בישראל'
    ],
    'program', 'new', 'קורס הנדל"ן',
    'מעולה! הנה כל הפרטים על קורס הנדל"ן המקיף בישראל 🦏' || E'\n'
      || 'https://karnafnadlan.com/course' || E'\n'
      || 'ואם יש שאלה — אפשר פשוט לכתוב לי כאן.'
  ),
  (
    'investor_mentorship', 30,
    'ליווי משקיעים פרימיום 1:1',
    array[
      '3', 'משקיעים', 'משקיע', 'ליווי משקיעים', 'פרימיום',
      'ליווי משקיעים פרימיום 1:1', 'שחר'
    ],
    'investor_mentorship', 'form_submitted', 'ליווי משקיעים',
    'מעולה! ליווי משקיעים 1:1 זה המסלול הכי מקיף שלנו 🦏' || E'\n'
      || 'כדי להתקדם, שלח/י הודעה ישירות לחטיבת ליווי המשקיעים שלנו בקישור:' || E'\n'
      || 'https://karnaf-crm.vercel.app/api/go/investors' || E'\n'
      || 'ואפשר גם פשוט לענות כאן ונחזור אליך.'
  ),
  (
    'human', 90,
    'מעבר לנציג',
    array['4', 'נציג', 'אנושי', 'בן אדם', 'מישהו', 'שיחה', 'מעבר לנציג'],
    'human', null, 'נציג אנושי',
    null
  )
on conflict (option_key) do update set
  display_order = excluded.display_order,
  label_he = excluded.label_he,
  match_terms = excluded.match_terms,
  track = excluded.track,
  stage = excluded.stage,
  interest_topic = excluded.interest_topic,
  followup_text = excluded.followup_text,
  updated_at = now();
