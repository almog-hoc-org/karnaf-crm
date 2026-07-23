-- 112_website_nurture.sql
--
-- Nurture sequence for website leads (docs/UPGRADE.md item 6 of the
-- karnaf_website repo, implemented in the CRM's own journey engine
-- instead of a Make.com scenario).
--
-- Data-only migration, same pattern as 068/086:
-- 1) three WhatsApp nurture templates (day 2 / day 5 / day 9),
-- 2) a journey definition (website_nurture) with cancel_on_reply,
-- 3) a bridge rule lead.created -> journey_start, seeded DISABLED with
--    enable_after_meta_approval (087 pattern) — brand-new leads have no
--    open 24h window, so every step MUST be an approved Meta template.
--    The operator enables the rule in /automations after Meta approves.

insert into public.message_templates
  (key, channel, name_he, description, body, variables_used, tags, status, notes, metadata)
values
  (
    'karnaf_website_nurture_d2_v1',
    'whatsapp',
    'טיפוח ליד אתר — יום 2 (ערך)',
    'נשלחת יומיים אחרי הרשמה באתר אם הליד עוד לא ענה: תוכן ערך קצר שמזמין שיחה.',
    'היי {{first_name}}, זו נועה מקרנף נדל״ן 🦏' || E'\n\n' || 'רציתי לוודא שקיבלת את מה שחיפשת אצלנו באתר. הרבה מתלבטים בדיוק באותה נקודה — כמה הון עצמי באמת צריך, ואיך יודעים אם העסקה נכונה.' || E'\n\n' || 'אם יש שאלה שמעסיקה אותך, אפשר פשוט לענות כאן ונכוון אותך.',
    array['first_name'],
    array['nurture', 'website', 'whatsapp'],
    'active',
    'Meta template name: karnaf_website_nurture_d2_v1, language he.',
    jsonb_build_object(
      'meta_template_name', 'karnaf_website_nurture_d2_v1',
      'meta_language', 'he',
      'meta_category', 'MARKETING',
      'expected_params', jsonb_build_array('first_name'),
      'meta_status', 'PENDING'
    )
  ),
  (
    'karnaf_website_nurture_d5_v1',
    'whatsapp',
    'טיפוח ליד אתר — יום 5 (הוכחה חברתית)',
    'נשלחת חמישה ימים אחרי ההרשמה: סיפור הצלחה קצר של לקוח.',
    'היי {{first_name}}, רק דוגמה קטנה מהשטח 🦏' || E'\n\n' || 'זוג שליווינו לאחרונה היה בטוח שאין להם מספיק הון עצמי לדירה — אחרי בדיקה מסודרת התברר שדווקא יש, והם כבר אחרי חתימה.' || E'\n\n' || 'אם גם אצלך התמונה לא לגמרי ברורה, שווה לבדוק ביחד. אפשר לענות כאן.',
    array['first_name'],
    array['nurture', 'website', 'whatsapp'],
    'active',
    'Meta template name: karnaf_website_nurture_d5_v1, language he.',
    jsonb_build_object(
      'meta_template_name', 'karnaf_website_nurture_d5_v1',
      'meta_language', 'he',
      'meta_category', 'MARKETING',
      'expected_params', jsonb_build_array('first_name'),
      'meta_status', 'PENDING'
    )
  ),
  (
    'karnaf_website_nurture_d9_v1',
    'whatsapp',
    'טיפוח ליד אתר — יום 9 (הזמנה לשיחה)',
    'הודעת הסגירה של הרצף: הזמנה לשיחת התאמה קצרה, ללא לחץ.',
    'היי {{first_name}}, זו ההודעה האחרונה שלנו ברצף הזה 🦏' || E'\n\n' || 'אם הנושא של רכישת דירה עדיין על הפרק, אנחנו מציעים שיחת התאמה קצרה וללא עלות — בודקים ביחד איפה אתה עומד ומה הצעד הנכון הבא.' || E'\n\n' || 'רוצה שנתאם? פשוט תענה כאן במילה ״כן״.',
    array['first_name'],
    array['nurture', 'website', 'whatsapp'],
    'active',
    'Meta template name: karnaf_website_nurture_d9_v1, language he.',
    jsonb_build_object(
      'meta_template_name', 'karnaf_website_nurture_d9_v1',
      'meta_language', 'he',
      'meta_category', 'MARKETING',
      'expected_params', jsonb_build_array('first_name'),
      'meta_status', 'PENDING'
    )
  )
on conflict (key, channel) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  body = excluded.body,
  variables_used = excluded.variables_used,
  tags = excluded.tags,
  status = excluded.status,
  notes = excluded.notes,
  metadata = excluded.metadata,
  updated_at = now();

-- The journey: 3 paced touches. First step fires 48h after enrollment
-- (day 0 is covered by lifecycle_landing_lead_welcome), then +72h and
-- +96h. cancel_on_reply=true is honored by the journey runner: a lead
-- that replied (or closed won/lost) after enrollment is cancelled
-- before the next step ever sends.
insert into public.journey_definitions
  (code, name_he, description, trigger_event, trigger_conditions, steps, enabled, allow_concurrent, metadata)
values
  ('website_nurture',
   'מסע טיפוח ללידים מהאתר',
   'רצף וואטסאפ של 3 נגיעות (יום 2, 5, 9) ללידים שנרשמו באתר ולא ענו. מבוטל אוטומטית ברגע שהליד עונה או נסגר.',
   'lead.created',
   jsonb_build_object(
     'all', jsonb_build_array(
       jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false)
     )
   ),
   jsonb_build_array(
     jsonb_build_object(
       'name', 'day_2_value',
       'delay_hours', 48,
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'karnaf_website_nurture_d2_v1', 'channel', 'whatsapp', 'once', true)
       )
     ),
     jsonb_build_object(
       'name', 'day_5_social_proof',
       'delay_hours', 72,
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'karnaf_website_nurture_d5_v1', 'channel', 'whatsapp', 'once', true)
       )
     ),
     jsonb_build_object(
       'name', 'day_9_fit_call_cta',
       'delay_hours', 96,
       'actions', jsonb_build_array(
         jsonb_build_object('type', 'send_template', 'key', 'karnaf_website_nurture_d9_v1', 'channel', 'whatsapp', 'once', true)
       )
     )
   ),
   true,
   false,
   jsonb_build_object('cancel_on_reply', true)
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  trigger_conditions = excluded.trigger_conditions,
  steps = excluded.steps,
  allow_concurrent = excluded.allow_concurrent,
  metadata = excluded.metadata;

-- Bridge rule: lead.created (now also emitted by website-leads-intake)
-- -> start the nurture journey. Website sources only — webinar has its
-- own funnel and presale_form has a dedicated AI track. Seeded DISABLED
-- until the Meta templates are approved (087 pattern).
insert into public.automation_rules
  (code, name_he, description, trigger_event, category, source, enabled, implementation_ref, conditions, actions, metadata)
values
  (
    'bridge_website_lead_created_start_nurture',
    'ליד אתר חדש → מסע טיפוח',
    'מכניס לידים חדשים מהאתר (טפסים/דפי נחיתה/לידים מגנטיים) למסע website_nurture. מופעל ידנית אחרי אישור התבניות במטא.',
    'lead.created',
    'lifecycle',
    'engine',
    false,
    'website-leads-intake + automation-engine + journey runner',
    jsonb_build_object(
      'all', jsonb_build_array(
        jsonb_build_object('field', 'lead.source', 'op', 'in', 'value', jsonb_build_array('responder_form', 'landing_page', 'lead_magnet')),
        jsonb_build_object('field', 'lead.do_not_contact', 'op', 'eq', 'value', false)
      )
    ),
    jsonb_build_array(
      jsonb_build_object('type', 'journey_start', 'code', 'website_nurture')
    ),
    jsonb_build_object('enable_after_meta_approval', true)
  )
on conflict (code) do update set
  name_he = excluded.name_he,
  description = excluded.description,
  trigger_event = excluded.trigger_event,
  category = excluded.category,
  source = excluded.source,
  implementation_ref = excluded.implementation_ref,
  conditions = excluded.conditions,
  actions = excluded.actions,
  metadata = excluded.metadata,
  updated_at = now();
