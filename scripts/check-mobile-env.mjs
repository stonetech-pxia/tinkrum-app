// Checks official app release builds only; source versions can omit the relay address or use their own AI service.
const MOBILE_RELEASE_ENV = [
  'EXPO_PUBLIC_MORPH_API_URL',
  'EXPO_PUBLIC_MORPH_TOOLS_URL',
  'EXPO_PUBLIC_MORPH_PACKS_URL',
  'EXPO_PUBLIC_MORPH_CLIENT_TOKEN',
];

const missing = MOBILE_RELEASE_ENV.filter((name) => !process.env[name]?.trim());
const invalid = MOBILE_RELEASE_ENV.slice(0, 3).filter((name) => {
  if (missing.includes(name)) return false;
  try {
    return !['http:', 'https:'].includes(new URL(process.env[name]).protocol);
  } catch {
    return true;
  }
});
if (missing.length || invalid.length) {
  if (missing.length) console.error(`Missing mobile release variables: ${missing.join(', ')}`);
  if (invalid.length) console.error(`Invalid mobile release URLs: ${invalid.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('Mobile release environment is complete (values hidden).');
}
