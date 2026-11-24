// Replaces expo-localization when running app code in Node: the language is given by the test case parameters rather than reading the system language.
exports.getLocales = () => [{ languageTag: 'en-US', languageCode: 'en' }];
exports.getCalendars = () => [{ timeZone: 'UTC' }];
