-- AI illustrations: each shot, storyboard frame and production can carry a small scene spec that the app draws
-- as a pitch-style illustration (docs/js/sketch.js). Specs describe the picture only: no costs, no people's details.
alter table public.shots add column if not exists illustration jsonb;
alter table public.storyboard_frames add column if not exists illustration jsonb;
alter table public.productions add column if not exists cover jsonb;
