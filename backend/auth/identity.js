// Only an authenticated broker profile can bind a worker to an app identity.
function authError(message, statusCode = 401) { return Object.assign(new Error(message), { statusCode }); }
function profileIdentity(result) {
  if (result?.isError) return null;
  let profile;
  try { profile = JSON.parse(result?.content?.[0]?.text || 'null'); } catch { return null; }
  profile = profile?.data || profile;
  const id = typeof profile?.user_id === 'string' ? profile.user_id.trim().toUpperCase() : '';
  return /^[A-Z0-9]{3,20}$/.test(id) ? id : null;
}
function createIdentityManager() {
  let identity = null;
  let revoked = false;
  const getIdentity = () => revoked ? null : identity;
  function setIdentity(next) {
    if (revoked || (identity && identity.kiteUserId !== next.kiteUserId)) {
      revoked = true;
      throw authError('Kite account changed. Sign out and sign in again.');
    }
    identity = Object.freeze({ ...next });
    return identity;
  }
  async function bindKiteIdentity(rawDb, result) {
    const kiteUserId = profileIdentity(result);
    if (!kiteUserId) {
      if (identity) revoked = true;
      throw authError('Sign in with Kite to continue.');
    }
    if (revoked) throw authError('Kite session ended. Sign in again.');
    if (identity) return setIdentity({ ...identity, kiteUserId });
    if (!rawDb) throw authError('Workspace database is not configured.', 503);
    let { data, error } = await rawDb.from('app_users').select('id,kite_user_id').eq('kite_user_id', kiteUserId).maybeSingle();
    if (error) throw authError('Workspace ownership migration is required. Run backend/migrate_kite_users.sql in Supabase.', 503);
    if (!data) {
      const inserted = await rawDb.from('app_users').upsert({ kite_user_id: kiteUserId }, { onConflict: 'kite_user_id', ignoreDuplicates: true });
      if (inserted.error) throw authError('Could not create the Kite workspace identity.', 503);
      ({ data, error } = await rawDb.from('app_users').select('id,kite_user_id').eq('kite_user_id', kiteUserId).single());
    }
    if (error || !data?.id || data.kite_user_id !== kiteUserId) throw authError('Could not load the Kite workspace identity.', 503);
    return setIdentity({ appUserId: data.id, kiteUserId });
  }
  return { getIdentity, setIdentity, bindKiteIdentity };
}
module.exports = { ...createIdentityManager(), createIdentityManager, profileIdentity };
