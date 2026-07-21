-- 107_email_assets_bucket.sql
--
-- Public bucket for images embedded in emails (and future landing
-- pages). Unlike whatsapp-media (private, staff-read), email images
-- must be publicly fetchable by every mail client. Uploads restricted
-- to active staff.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'email-assets',
  'email-assets',
  true,
  10485760, -- 10 MiB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'email_assets_public_read'
  ) then
    create policy email_assets_public_read on storage.objects
      for select using (bucket_id = 'email-assets');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'email_assets_staff_write'
  ) then
    create policy email_assets_staff_write on storage.objects
      for insert to authenticated
      with check (bucket_id = 'email-assets' and public.is_active_staff());
  end if;
end $$;
