const QA_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

function resolveQaProfile(value, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv !== "development" || typeof value !== "string") return null;
  const profile = value.trim().toLowerCase();
  return QA_PROFILE_PATTERN.test(profile) ? profile : null;
}

function qaUserDataDirectoryName(channel, profile) {
  return profile ? `OpenWhispr-${channel}-${profile}` : `OpenWhispr-${channel}`;
}

function qaWindowTitle(title, profile = resolveQaProfile(process.env.OPENWHISPR_QA_PROFILE)) {
  return profile ? `${title} — ${profile}` : title;
}

module.exports = { qaUserDataDirectoryName, qaWindowTitle, resolveQaProfile };
