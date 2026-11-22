// 入口：先加载提醒按钮的后台处理（D-318，App 没开着时也要能用），再启动 Expo Router。
// 根组件外面套一层启动兜底（体检 6.6，D-621）：连续两次没能正常打开时
// 先显示兜底页，app/ 下的路由（主流程）等用户点「照常打开」才加载。写法照 Expo Router 的自定义入口。
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
// 兜底页用系统语言：设置里选的语言存在数据库里，兜底页不去读。
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
