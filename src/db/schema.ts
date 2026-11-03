/**
 * Schema migrations, ordered by version. `PRAGMA user_version` records how many
 * entries have been applied; each entry runs once, inside a transaction.
 *
 * Invariants every table must keep:
 * - searchable text lives in a `content_seg` column written by `segment()`;
 * - the FTS5 tables are external-content tables fed only by triggers, so the
 *   index can never drift from the row that produced it;
 * - timestamps are UTC strings (`datetime('now')`), never local time.
 *
 * @module dsn-mnemo/db/schema
 */

/** L0 exact log plus L1 diaries, L3 anchors, L2 working state. */
const V1 = `
create table sessions (
  id text primary key,
  started_at text not null default (datetime('now')),
  last_active_at text not null default (datetime('now')),
  turn_count integer not null default 0,
  relation_stage text not null default 'initial',
  diary_judged_at text
);

create table messages (
  id integer primary key autoincrement,
  session_id text not null references sessions(id) on delete cascade,
  seq integer not null,
  turn integer not null default 0,
  role text not null check (role in ('user', 'assistant', 'tool')),
  message_id text,
  content text not null,
  content_seg text not null,
  raw text not null,
  created_at text not null default (datetime('now')),
  unique (session_id, seq)
);
create index idx_messages_session_turn on messages(session_id, turn);
create index idx_messages_created on messages(created_at desc);

create virtual table messages_fts using fts5(
  content,
  content = 'messages',
  content_rowid = 'id',
  tokenize = 'unicode61'
);
create trigger messages_ai after insert on messages begin
  insert into messages_fts(rowid, content) values (new.id, new.content_seg);
end;
create trigger messages_ad after delete on messages begin
  insert into messages_fts(messages_fts, rowid, content) values ('delete', old.id, old.content_seg);
end;

create table diaries (
  id integer primary key autoincrement,
  session_id text references sessions(id) on delete set null,
  content text not null,
  content_seg text not null,
  importance real not null default 0.5,
  emotion real not null default 0.5,
  type_tags text not null default '',
  created_at text not null default (datetime('now')),
  updated_at text
);
create index idx_diaries_created on diaries(created_at desc);
create index idx_diaries_importance on diaries(importance desc);

create virtual table diaries_fts using fts5(
  content,
  content = 'diaries',
  content_rowid = 'id',
  tokenize = 'unicode61'
);
create trigger diaries_ai after insert on diaries begin
  insert into diaries_fts(rowid, content) values (new.id, new.content_seg);
end;
create trigger diaries_ad after delete on diaries begin
  insert into diaries_fts(diaries_fts, rowid, content) values ('delete', old.id, old.content_seg);
end;
create trigger diaries_au after update of content_seg on diaries begin
  insert into diaries_fts(diaries_fts, rowid, content) values ('delete', old.id, old.content_seg);
  insert into diaries_fts(rowid, content) values (new.id, new.content_seg);
end;

create table anchors (
  id integer primary key autoincrement,
  event_name text not null,
  target_date text not null,
  window_days integer,
  tone_hint text,
  last_fired_on text,
  created_at text not null default (datetime('now')),
  unique (event_name, target_date)
);
create index idx_anchors_target on anchors(target_date);

create table work_state (
  session_id text not null references sessions(id) on delete cascade,
  key text not null,
  value text not null,
  updated_at text not null default (datetime('now')),
  primary key (session_id, key)
);

create table diary_revisions (
  id integer primary key autoincrement,
  diary_id integer not null references diaries(id) on delete cascade,
  content text not null,
  reason text not null,
  created_at text not null default (datetime('now'))
);
create index idx_diary_revisions_diary on diary_revisions(diary_id);
`

/**
 * V2: memory subjects.
 *
 * A memory belongs to a `(subject_kind, subject_id)` pair — a person for 1:1
 * chats or a group for group chats. `messages` gains per-message speaker and
 * "was the assistant addressed" so group logs can be filtered without waking
 * the model; `memory_points` is the short-term (7 day) layer; anchors gain
 * ownership, recurrence, and handled/surfaced state for the "missed" rule.
 *
 * Existing rows are backfilled onto the local desktop user (`local`).
 */
const V2 = `
alter table sessions add column kind text not null default 'dm';
alter table sessions add column audience_id text;

alter table messages add column speaker_id text;
alter table messages add column addressed integer not null default 0;

alter table diaries add column subject_kind text;
alter table diaries add column subject_id text;
alter table diaries add column visibility text not null default 'private';

-- Anchors gain ownership, recurrence and state; rebuild the table so the
-- uniqueness key includes the subject (two people may share a date).
create table anchors_v2 (
  id integer primary key autoincrement,
  event_name text not null,
  target_date text not null,
  window_days integer,
  tone_hint text,
  last_fired_on text,
  created_at text not null default (datetime('now')),
  subject_kind text,
  subject_id text,
  repeat text not null default 'none' check (repeat in ('none', 'daily', 'weekly', 'monthly', 'yearly')),
  handled_at text,
  unique (subject_kind, subject_id, event_name, target_date)
);
insert into anchors_v2(id, event_name, target_date, window_days, tone_hint, last_fired_on, created_at)
  select id, event_name, target_date, window_days, tone_hint, last_fired_on, created_at from anchors;
drop table anchors;
alter table anchors_v2 rename to anchors;
create index idx_anchors_target on anchors(target_date);

create table memory_points (
  id integer primary key autoincrement,
  subject_kind text not null,
  subject_id text not null,
  kind text not null default 'topic',
  text text not null,
  content_seg text not null,
  importance real not null default 0.5,
  source text not null default 'diary',
  mentions integer not null default 1,
  promoted integer not null default 0,
  last_seen_at text not null default (datetime('now')),
  created_at text not null default (datetime('now')),
  expires_at text not null
);
create index idx_memory_points_subject on memory_points(subject_kind, subject_id, created_at desc);
create index idx_memory_points_expiry on memory_points(expires_at);

create virtual table memory_points_fts using fts5(
  text,
  content = 'memory_points',
  content_rowid = 'id',
  tokenize = 'unicode61'
);
create trigger memory_points_ai after insert on memory_points begin
  insert into memory_points_fts(rowid, text) values (new.id, new.content_seg);
end;
create trigger memory_points_ad after delete on memory_points begin
  insert into memory_points_fts(memory_points_fts, rowid, text) values ('delete', old.id, old.content_seg);
end;
create trigger memory_points_au after update of content_seg on memory_points begin
  insert into memory_points_fts(memory_points_fts, rowid, text) values ('delete', old.id, old.content_seg);
  insert into memory_points_fts(rowid, text) values (new.id, new.content_seg);
end;

create table persons (
  user_id text primary key,
  display_name text,
  relationship text not null default 'stranger',
  public_note text,
  first_seen text not null default (datetime('now')),
  last_seen text not null default (datetime('now'))
);

create index idx_diaries_subject on diaries(subject_kind, subject_id, created_at desc);
create index idx_anchors_subject on anchors(subject_kind, subject_id, target_date);

update sessions set audience_id = 'local' where audience_id is null;
update diaries set
  subject_kind = 'user',
  subject_id = coalesce((select audience_id from sessions s where s.id = diaries.session_id), 'local')
where subject_kind is null;
update anchors set subject_kind = 'user', subject_id = 'local' where subject_kind is null;
`

/**
 * V3: track when the last completed turn ended. The pending-diary hint needs a
 * timestamp that is *not* refreshed by a new `turn/start`, so it can measure the
 * quiet gap since the previous reply.
 */
const V3 = `
alter table sessions add column last_turn_end_at text;
`

/** Every migration in application order. Append only; never edit a released entry. */
export const MIGRATIONS: readonly string[] = [V1, V2, V3]

/** Highest schema version this build understands. */
export const SCHEMA_VERSION = MIGRATIONS.length
