-- 100_after_webinar_template.sql
--
-- New Meta template "after_webinar" — post-webinar follow-up broadcast.
-- Seeded locally so it shows up in the broadcast compose options right
-- away; the live Meta body + approval status land on metadata.meta via
-- the template sync (button or nightly cron), and the local body can
-- then be aligned from the Templates page.

insert into public.message_templates (key, channel, name_he, description, body, variables_used, tags, status)
values (
  'after_webinar',
  'whatsapp',
  'הודעת המשך אחרי וובינר',
  'תבנית Meta מאושרת בשם after_webinar. נשלחת כתפוצה למשתתפי/נרשמי הוובינר אחרי המפגש.',
  'הודעת המשך למשתתפי הוובינר של "הדרך לדירה". הנוסח שנשלח בפועל הוא תבנית המטא after_webinar — לחצו "סנכרן ממטא" במסך התבניות כדי לראות אותו כאן ולעדכן את התצוגה.',
  array[]::text[],
  array['webinar', 'meta'],
  'active'
)
on conflict (key, channel) do nothing;
