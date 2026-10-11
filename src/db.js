// This is a trusted, server-side data layer. The app authenticates users with
// cookie sessions and never forwards a per-user JWT to PostgREST, so RLS
// policies based on auth.uid() can never match for requests made here. Using
// the anon key therefore silently returns zero rows (and blocks writes) once
// RLS is enabled — breaking login, dashboards, and the scheduler. Every query
// in this module must run with the service-role key, which bypasses RLS.
const { supabaseAdmin } = require('./supabase');
const supabase = supabaseAdmin;

// The responses table gained a `mark_source` column (see supabase/schema.sql).
// Production applies that as a manual DDL migration, so until it has run the
// column may not exist yet. These helpers let response writes that include
// mark_source degrade gracefully (drop the field and retry) instead of failing
// the user's "Prayed / Not Prayed" action or the scheduler's auto-mark.
function isUndefinedColumnError(error, column) {
  if (!error) return false;
  const text = `${error.code || ''} ${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return text.includes(column) && (/42703|PGRST204|column .* does not exist|does not exist/i.test(text));
}


// Database helper functions using Supabase
const db = {
  // Groups
  async createGroup(groupData) {
    const { data, error } = await supabaseAdmin
      .from('groups')
      .insert(groupData)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async getGroupByCode(code) {
    const { data, error } = await supabase
      .from('groups')
      .select('*')
      .eq('code', code)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async getGroupById(id) {
    const { data, error } = await supabase
      .from('groups')
      .select('*')
      .eq('id', id)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async updateGroup(id, updates) {
    const { data, error } = await supabaseAdmin
      .from('groups')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async deleteGroup(id) {
    const { error } = await supabaseAdmin
      .from('groups')
      .delete()
      .eq('id', id);
    if (error) throw error;
  },

  // User Profiles
  async createUserProfile(profileData) {
    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .insert(profileData)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async getUserProfile(userId) {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async updateUserProfile(userId, updates) {
    const { data, error } = await supabase
      .from('user_profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();
    // Migration 0005 (locale) not applied yet? Strip just that field and retry so
    // profile/notification saves never break while the DB catches up.
    if (error && isUndefinedColumnError(error, 'locale')) {
      console.warn('[db] user_profiles.locale missing — run migration 0005. Retrying without it.');
      const { locale, ...rest } = updates;
      return this.updateUserProfile(userId, rest);
    }
    // Migration 0006 (settings) not applied yet? Same degrade for the
    // calendar/tasbeeh prefs blob — the features keep working from localStorage
    // and the browser simply can't persist the server copy until it's applied.
    if (error && isUndefinedColumnError(error, 'settings')) {
      console.warn('[db] user_profiles.settings missing — run migration 0006. Retrying without it.');
      const { settings, ...rest } = updates;
      return this.updateUserProfile(userId, rest);
    }
    if (error) throw error;
    return data;
  },

  // Prayer Times
  async createPrayerTime(prayerTimeData) {
    const { data, error } = await supabase
      .from('prayer_times')
      .insert(prayerTimeData)
      .select()
      .single();
    // Migration 0003 not applied yet? Drop only the new columns and retry, so
    // times keep caching (the app's core function) while the DB catches up.
    if (error && isUndefinedColumnError(error, 'hijri_day')) {
      console.warn('[db] prayer_times hijri/imsak columns missing — run migration 0003. Retrying without them.');
      const { imsak, sunrise, hijri_day, hijri_month_num, hijri_month, hijri_year, ...rest } = prayerTimeData;
      const retry = await supabase.from('prayer_times').insert(rest).select().single();
      if (retry.error) throw retry.error;
      return retry.data;
    }
    if (error) throw error;
    return data;
  },

  async getPrayerTime(userId, date) {
    const { data, error } = await supabase
      .from('prayer_times')
      .select('*')
      .eq('user_id', userId)
      .eq('date', date)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async getPrayerTimesByUser(userId) {
    const { data, error } = await supabase
      .from('prayer_times')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false });
    if (error) throw error;
    return data;
  },

  async updatePrayerTime(id, updates) {
    const { data, error } = await supabase
      .from('prayer_times')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  // Drop a user's cached prayer times from `fromDate` (YYYY-MM-DD) onward, so the
  // next dashboard load / scheduler tick re-fetches them. Called when a user
  // changes their city/country (or the calculation method changes), otherwise the
  // per-(user,date) cache would keep serving times for the old location.
  // `date` is stored as TEXT 'YYYY-MM-DD', so lexicographic >= is a valid compare.
  async deletePrayerTimesFrom(userId, fromDate) {
    let query = supabase.from('prayer_times').delete().gte('date', fromDate);
    if (userId) query = query.eq('user_id', userId);
    const { error } = await query;
    if (error) throw error;
  },

  // Responses
  async createResponse(responseData) {
    const { data, error } = await supabase
      .from('responses')
      .insert(responseData)
      .select()
      .single();
    if (error && isUndefinedColumnError(error, 'mark_source')) {
      console.warn('[db] responses.mark_source missing — run the schema migration. Retrying without it.');
      const { mark_source, ...rest } = responseData;
      const retry = await supabase.from('responses').insert(rest).select().single();
      if (retry.error) throw retry.error;
      return retry.data;
    }
    // Migration 0004 (kind/made_up_at) not applied yet? Strip and retry via the
    // same degrade chain so fast rows and qaḍā writes never break the tick.
    if (error && isUndefinedColumnError(error, 'kind')) {
      console.warn('[db] responses.kind missing — run migration 0004. Retrying without it.');
      const { kind, ...rest } = responseData;
      return this.createResponse(rest);
    }
    if (error) throw error;
    return data;
  },

  async getResponse(userId, prayerName, date) {
    const { data, error } = await supabase
      .from('responses')
      .select('*')
      .eq('user_id', userId)
      .eq('prayer_name', prayerName)
      .eq('date', date)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async getResponsesByUser(userId) {
    const { data, error } = await supabase
      .from('responses')
      .select('*')
      .eq('user_id', userId)
      .order('date', { ascending: false });
    if (error) throw error;
    return data;
  },

  async getResponsesByGroup(groupId) {
    const { data, error } = await supabase
      .from('responses')
      .select('*')
      .eq('group_id', groupId)
      .order('date', { ascending: false });
    if (error) throw error;
    return data;
  },

  async updateResponse(id, updates) {
    const { data, error } = await supabase
      .from('responses')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error && isUndefinedColumnError(error, 'mark_source')) {
      console.warn('[db] responses.mark_source missing — run the schema migration. Retrying without it.');
      const { mark_source, ...rest } = updates;
      const retry = await supabase.from('responses').update(rest).eq('id', id).select().single();
      if (retry.error) throw retry.error;
      return retry.data;
    }
    if (error && isUndefinedColumnError(error, 'made_up_at')) {
      console.warn('[db] responses.made_up_at missing — run migration 0004. Retrying without it.');
      const { made_up_at, ...rest } = updates;
      return this.updateResponse(id, rest);
    }
    if (error) throw error;
    return data;
  },

  async getTodayResponsesByGroup(groupId, date) {
    const { data, error } = await supabase
      .from('responses')
      .select('*')
      .eq('group_id', groupId)
      .eq('date', date);
    if (error) throw error;
    return data;
  },

  // Notifications Log
  async createNotificationLog(notificationData) {
    const { data, error } = await supabase
      .from('notifications_log')
      .insert(notificationData)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  // Set of "prayer|type" keys that already have a log row for this user's LOCAL
  // date. Kept for back-compat / diagnostics; the scheduler now uses
  // getNotificationLogStatuses so it can distinguish retryable rows.
  async getNotificationLogKeys(userId, date) {
    const { data, error } = await supabase
      .from('notifications_log')
      .select('prayer_name, type')
      .eq('user_id', userId)
      .eq('date', date);
    if (error) throw error;
    return new Set((data || []).map((r) => `${r.prayer_name}|${r.type}`));
  },

  // Map of "prayer|type" -> { status, claimed_at } for one user's local date.
  // The scheduler builds its handled-set from this (see scheduler.handledSetFrom)
  // so 'failed' / abandoned claims can be retried while the window is open.
  // If the claimed_at column (migration 0008) is not present yet, degrade to
  // selecting without it — every non-terminal row then reads as in-flight, which
  // reproduces the old conservative behaviour instead of erroring.
  async getNotificationLogStatuses(userId, date) {
    let query = supabase.from('notifications_log').select('prayer_name, type, status').eq('user_id', userId).eq('date', date);
    let { data, error } = await query;
    if (error && isUndefinedColumnError(error, 'status')) {
      // Pre-migration 0002 DB: no status column; every row is a completed send.
      const retry = await supabase.from('notifications_log').select('prayer_name, type').eq('user_id', userId).eq('date', date);
      if (retry.error) throw retry.error;
      const m = new Map();
      for (const r of retry.data || []) m.set(`${r.prayer_name}|${r.type}`, { status: 'sent', claimed_at: null });
      return m;
    }
    if (error) throw error;
    const map = new Map();
    for (const r of data || []) map.set(`${r.prayer_name}|${r.type}`, { status: r.status, claimed_at: null });
    // Best-effort claimed_at enrichment (skipped silently if column missing).
    const withClaim = await supabase.from('notifications_log').select('prayer_name, type, claimed_at').eq('user_id', userId).eq('date', date);
    if (!withClaim.error) {
      for (const r of withClaim.data || []) {
        const k = `${r.prayer_name}|${r.type}`;
        if (map.has(k)) map.get(k).claimed_at = r.claimed_at || null;
      }
    }
    return map;
  },

  // Insert-first claim on (user_id, prayer_name, date, type): ON CONFLICT DO
  // NOTHING, so two overlapping ticks can never both "win" the same fresh email.
  // Returns the inserted row when this caller owns the event, or null when a row
  // already exists (which then goes through retryClaimNotificationLog).
  // entry.status is 'sending' for a send claim; scheduled_at/claimed_at carry the
  // due instant and the claim instant. Degrades if status/scheduled_at/claimed_at
  // columns are absent so the dedup contract still holds on an un-migrated DB.
  async claimNotificationLog(entry) {
    const { data, error } = await supabase
      .from('notifications_log')
      .upsert(entry, { onConflict: 'user_id,prayer_name,date,type', ignoreDuplicates: true })
      .select();
    if (error && (isUndefinedColumnError(error, 'status') || isUndefinedColumnError(error, 'scheduled_at') || isUndefinedColumnError(error, 'claimed_at'))) {
      const strip = { ...entry };
      if (isUndefinedColumnError(error, 'status')) delete strip.status;
      if (isUndefinedColumnError(error, 'scheduled_at')) delete strip.scheduled_at;
      if (isUndefinedColumnError(error, 'claimed_at')) delete strip.claimed_at;
      const retry = await supabase
        .from('notifications_log')
        .upsert(strip, { onConflict: 'user_id,prayer_name,date,type', ignoreDuplicates: true })
        .select();
      if (retry.error) throw retry.error;
      return retry.data && retry.data.length ? retry.data[0] : null;
    }
    if (error) throw error;
    return data && data.length ? data[0] : null;
  },

  // Atomically claim an EXISTING retryable row (status 'failed', or a
  // 'pending'/'sending' left abandoned > abandonMin minutes) for a fresh send
  // attempt. A single UPDATE guarded on the retryable status returns the row to
  // exactly ONE concurrent caller (row lock serialises the others, whose WHERE no
  // longer matches). Returns the claimed row, or null when nothing was claimable.
  async retryClaimNotificationLog(base, claimedAtIso, abandonMin = 2) {
    const key = {
      user_id: base.user_id, prayer_name: base.prayer_name,
      date: base.date, type: base.type,
    };
    const cutoff = new Date(Date.now() - abandonMin * 60000).toISOString();
    // 1) failed → sending
    let { data, error } = await supabase
      .from('notifications_log')
      .update({ status: 'sending', claimed_at: claimedAtIso })
      .eq('user_id', key.user_id).eq('prayer_name', key.prayer_name)
      .eq('date', key.date).eq('type', key.type)
      .eq('status', 'failed')
      .select();
    if (!error && data && data.length) return data[0];
    // 2) abandoned pending/sending → sending (only possible with claimed_at)
    const { data: ab, error: abErr } = await supabase
      .from('notifications_log')
      .update({ status: 'sending', claimed_at: claimedAtIso })
      .eq('user_id', key.user_id).eq('prayer_name', key.prayer_name)
      .eq('date', key.date).eq('type', key.type)
      .in('status', ['pending', 'sending'])
      .lt('claimed_at', cutoff)
      .select();
    if (!abErr && ab && ab.length) return ab[0];
    return null;
  },

  // Write a terminal SKIP outcome (skipped_stale / skipped_superseded /
  // skipped_already_logged). Insert-first when there is no row; if a row already
  // exists, convert it only when it is a retryable/in-flight state ('failed',
  // 'pending', 'sending') — never overwrite a real 'sent' or an earlier skip.
  // Returns a truthy row when this call wrote/converted the skip, else null.
  async resolveSkippedNotificationLog(entry) {
    const inserted = await this.claimNotificationLog(entry);
    if (inserted) return inserted;
    const { data, error } = await supabase
      .from('notifications_log')
      .update({ status: entry.status, scheduled_at: entry.scheduled_at })
      .eq('user_id', entry.user_id).eq('prayer_name', entry.prayer_name)
      .eq('date', entry.date).eq('type', entry.type)
      .in('status', ['failed', 'pending', 'sending'])
      .select();
    if (error && (isUndefinedColumnError(error, 'status') || isUndefinedColumnError(error, 'scheduled_at'))) return null;
    if (error) throw error;
    return data && data.length ? data[0] : null;
  },

  // Claimed row became a real send. In dry-run mode (SCHEDULER_DRY_RUN=1) the
  // caller still ends up here: the row is stamped 'sent' with a real sent_at so
  // the atomic-claim dedup keeps working and no email can double-send even
  // after dry-run mode is switched off for the day.
  async markNotificationLogSent(id) {
    const { error } = await supabase
      .from('notifications_log')
      .update({ status: 'sent', sent_at: new Date().toISOString(), claimed_at: new Date().toISOString() })
      .eq('id', id);
    if (error && isUndefinedColumnError(error, 'status')) return; // pre-migration DB: claim row itself is the dedup
    if (error && isUndefinedColumnError(error, 'claimed_at')) {
      const { error: e2 } = await supabase.from('notifications_log').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', id);
      if (e2 && !isUndefinedColumnError(e2, 'status')) throw e2;
      return;
    }
    if (error) throw error;
  },

  // SMTP attempt failed: keep the row (never delete) and mark it 'failed' with
  // the provider error so the next tick can retry inside the window and ops can
  // see why. claimed_at is refreshed so the abandon timer restarts.
  async markNotificationLogFailed(id, message) {
    const patch = { status: 'failed', claimed_at: new Date().toISOString(), error: String(message || 'smtp-error').slice(0, 500) };
    let { error } = await supabase.from('notifications_log').update(patch).eq('id', id);
    if (error && isUndefinedColumnError(error, 'error')) {
      const { error: e2 } = await supabase.from('notifications_log').update({ status: 'failed', claimed_at: new Date().toISOString() }).eq('id', id);
      if (e2 && isUndefinedColumnError(e2, 'claimed_at')) {
        await supabase.from('notifications_log').update({ status: 'failed' }).eq('id', id);
      } else if (e2) throw e2;
      return;
    }
    if (error && isUndefinedColumnError(error, 'claimed_at')) {
      const { error: e2 } = await supabase.from('notifications_log').update({ status: 'failed', error: patch.error }).eq('id', id);
      if (e2 && isUndefinedColumnError(e2, 'status')) return;
      if (e2) throw e2;
      return;
    }
    if (error) throw error;
  },

  // Legacy helper retained for the smoke script / manual cleanup; the scheduler
  // no longer deletes claims (it marks them 'failed' instead).
  async deleteNotificationLog(id) {
    const { error } = await supabase.from('notifications_log').delete().eq('id', id);
    if (error) throw error;
  },

  async getNotificationLog(userId, prayerName, date, type) {
    const { data, error } = await supabase
      .from('notifications_log')
      .select('*')
      .eq('user_id', userId)
      .eq('prayer_name', prayerName)
      .eq('date', date)
      .eq('type', type)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  // Group Invitations
  async createInvitation(invitationData) {
    const { data, error } = await supabaseAdmin
      .from('group_invitations')
      .insert(invitationData)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async getInvitationByToken(token) {
    const { data, error } = await supabaseAdmin
      .from('group_invitations')
      .select('*')
      .eq('token', token)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  },

  async updateInvitation(id, updates) {
    const { data, error } = await supabaseAdmin
      .from('group_invitations')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  async getPendingInvitationsByEmail(email) {
    const { data, error } = await supabaseAdmin
      .from('group_invitations')
      .select('*')
      .eq('email', email)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  // Get all users in a group
  async getGroupMembers(groupId) {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('group_id', groupId);
    if (error) throw error;
    return data;
  },

  // Remove user from group
  async removeUserFromGroup(userId) {
    const { data, error } = await supabase
      .from('user_profiles')
      .update({ group_id: null })
      .eq('id', userId)
      .select()
      .single();
    if (error) throw error;
    return data;
  },

  // Cron heartbeat (migration 0007) — a single row proving scheduler.tick()
  // actually ran in production. Written from tick's finally block, read by
  // GET /api/health. If the table doesn't exist yet (fresh DB, migration not
  // applied), log once and swallow so the tick never breaks ops tooling that
  // relies on this pattern degrading gracefully.
  async upsertCronHeartbeat(fields) {
    const entry = { id: 1, updated_at: new Date().toISOString(), ...fields };
    const { error } = await supabase
      .from('cron_heartbeat')
      .upsert(entry, { onConflict: 'id' });
    if (!error) return;
    // A brand-new count column (emails_superseded / emails_failed / user_error,
    // migration 0008) not applied yet? Strip exactly the offending column and
    // retry so the core heartbeat (last_started_at / emails_sent) still lands.
    const stripCandidates = ['emails_superseded', 'emails_failed', 'user_errors'];
    if (stripCandidates.some((c) => isUndefinedColumnError(error, c))) {
      const offending = stripCandidates.find((c) => isUndefinedColumnError(error, c));
      const { [offending]: _drop, ...rest } = entry;
      return this.upsertCronHeartbeat(rest);
    }
    if (/cron_heartbeat|does not exist|relation/i.test(`${error.code || ''} ${error.message || ''}`)) {
      if (!db._hbWarned) {
        db._hbWarned = true;
        console.warn('[db] cron_heartbeat table missing — apply migration 0007. Heartbeat writes will be no-ops.');
      }
      return;
    }
    throw error;
  },

  async getCronHeartbeat() {
    const { data, error } = await supabase
      .from('cron_heartbeat')
      .select('*')
      .eq('id', 1)
      .single();
    if (error && error.code === 'PGRST116') return null; // no row yet
    if (error && /cron_heartbeat|does not exist|relation/i.test(`${error.code || ''} ${error.message || ''}`)) return null;
    if (error) throw error;
    return data;
  }
};

module.exports = db;
