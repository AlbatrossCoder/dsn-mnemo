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
  relation_stage text not null default 'initial'
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
  window_days integer not null default 2,
  tone_hint text,
  last_fired_on text,
  created_at text not null default (datetime('now'))
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

/** Every migration in application order. Append only; never edit a released entry. */
export const MIGRATIONS: readonly string[] = [V1]

/** Highest schema version this build understands. */
export const SCHEMA_VERSION = MIGRATIONS.length
