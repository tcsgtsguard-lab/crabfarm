-- รันสคริปต์นี้ใน Supabase Dashboard > SQL Editor > New query
-- แล้วกด Run ครั้งเดียว (ทำครั้งเดียวตอนตั้งโปรเจกต์ใหม่)

create table if not exists crabfarm_kv (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);

-- เปิด Row Level Security (บังคับตามมาตรฐานของ Supabase)
alter table crabfarm_kv enable row level security;

-- อนุญาตให้อ่าน/เขียน/ลบได้แบบเปิด (เพราะแอปนี้ไม่มีระบบ login)
-- คำเตือน: ใครก็ตามที่มีลิงก์เว็บไซต์และ anon key จะแก้ไขข้อมูลได้
-- ถ้าต้องการจำกัดสิทธิ์ ให้ปรับ policy นี้ภายหลัง หรือเพิ่มระบบ login ของ Supabase
create policy "allow all access to crabfarm_kv"
  on crabfarm_kv
  for all
  using (true)
  with check (true);
