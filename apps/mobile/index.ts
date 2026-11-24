// Entry point: loads reminder button background processing first (D-318, must work when app is
// closed), then starts Expo Router. Wraps the root component with a startup fallback (health check
// 6.6, D-621): shows the fallback page if normal startup fails twice consecutively, loading app/
// routes (main flow) only when the user taps "Open normally". Follows Expo Router custom entry
// point conventions.
import './src/reminders/background';
import '@expo/metro-runtime';
import { App } from 'expo-router/build/qualified-entry';
import { renderRootComponent } from 'expo-router/build/renderRootComponent';
import { createElement } from 'react';

import { getDeviceLocale } from './src/i18n';
import { rescueActions } from './src/rescue/actions';
import { expoAttemptStore } from './src/rescue/expo-attempts';
import { RescueGate, recordFatalErrors, type StartSession } from './src/rescue/RescueGate';

recordFatalErrors(expoAttemptStore);
// Fallback page uses system locale: language selected in settings is stored in the database and not read by the fallback page.
const locale = getDeviceLocale();
const session: StartSession = {};
renderRootComponent(() =>
  createElement(RescueGate, {
    App,
    store: expoAttemptStore,
    session,
    locale,
    actions: rescueActions(locale),
  }),
);
