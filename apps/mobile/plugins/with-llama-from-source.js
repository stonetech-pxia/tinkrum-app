const { withGradleProperties } = require('expo/config-plugins');

// Build llama.rn from source on Android: prebuilt libraries write prompt tokens to logcat, which
// can be reverse-engineered to recover recognized text (invariants 1, 2). Patch located at
// patches/llama.rn+0.12.9.patch; iOS is unaffected by this flag. Such compilation causes Gradle's
// default 2 GB to be insufficient for R8 (OutOfMemoryError), so both are increased together.
module.exports = (config) =>
  withGradleProperties(config, (next) => {
    const set = {
      rnllamaBuildFromSource: 'true',
      'org.gradle.jvmargs': '-Xmx5g -XX:MaxMetaspaceSize=1g',
    };
    next.modResults = next.modResults.filter(
      (item) => !(item.type === 'property' && item.key in set),
    );
    for (const [key, value] of Object.entries(set))
      next.modResults.push({ type: 'property', key, value });
    return next;
  });
