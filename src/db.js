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
  // date. Used by the scheduler to skip handled events in one query per user.
  async getNotificationLogKeys(userId, date) {
    const { data, error } = await supabase
      .from('notifications_log')
      .select('prayer_name, type')
      .eq('user_id', userId)
      .eq('date', date);
    if (error) throw error;
    return new Set((data || []).map((r) => `${r.prayer_name}|${r.type}`));
  },

  // Insert-first claim on (user_id, prayer_name, date, type): ON CONFLICT DO
  // NOTHING, so two overlapping ticks (or serverless cron + in-process cron)
  // can never both "win" the same email. Returns the inserted row when this
  // caller owns the event, or null when a row already exists (sent/skipped).
  // status: 'sending' (claimed, email about to go out) | 'skipped_stale'.
  // scheduled_at: the UTC instant the email was scheduled for (diagnostics).
  async claimNotificationLog(entry) {
    const { data, error } = await supabase
      .from('notifications_log')
      .upsert(entry, { onConflict: 'user_id,prayer_name,date,type', ignoreDuplicates: true })
      .select();
    if (error && (isUndefinedColumnError(error, 'status') || isUndefinedColumnError(error, 'scheduled_at'))) {
      console.warn('[db] notifications_log.status/scheduled_at missing — run the schema migration. Retrying without them.');
      const { status, scheduled_at, ...rest } = entry;
      const retry = await supabase
        .from('notifications_log')
        .upsert(rest, { onConflict: 'user_id,prayer_name,date,type', ignoreDuplicates: true })
        .select();
      if (retry.error) throw retry.error;
      return retry.data && retry.data.length ? retry.data[0] : null;
    }
    if (error) throw error;
    return data && data.length ? data[0] : null;
  },

  // Claimed row became a real send. In dry-run mode (SCHEDULER_DRY_RUN=1) the
  // caller still ends up here: the row is stamped 'sent' with a real sent_at so
  // the atomic-claim dedup keeps working and no email can double-send even
  // after dry-run mode is switched off for the day. The tick itself records
  // `dry_run: true` on the cron_heartbeat row, which is the single source of
  // truth for "was this day's pipeline exercised without touching SMTP?".
  async markNotificationLogSent(id) {
    const { error } = await supabase
      .from('notifications_log')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('id', id);
    if (error && isUndefinedColumnError(error, 'status')) return; // pre-migration DB: claim row itself is the dedup
    if (error) throw error;
  },

  // Release a 'sending' claim whose SMTP attempt failed, so the next tick can
  // retry while the send window is still open. Only ever deletes 'sending' rows
  // — a sent or skipped row must stay to keep dedup honest.
  async deleteNotificationLog(id) {
    const { error } = await supabase
      .from('notifications_log')
      .delete()
      .eq('id', id)
      .eq('status', 'sending');
    if (error && isUndefinedColumnError(error, 'status')) {
      const retry = await supabase.from('notifications_log').delete().eq('id', id);
      if (retry.error) throw retry.error;
      return;
    }
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
    if (error && /cron_heartbeat|does not exist|relation/i.test(`${error.code || ''} ${error.message || ''}`)) {
      if (!db._hbWarned) {
        db._hbWarned = true;
        console.warn('[db] cron_heartbeat table missing — apply migration 0007. Heartbeat writes will be no-ops.');
      }
      return;
    }
    if (error) throw error;
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
