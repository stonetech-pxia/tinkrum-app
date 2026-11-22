import { File, Paths } from 'expo-file-system';

import type { AttemptStore } from './attempts';

// 启动计数文件在 Documents 里、数据库外面。用同步读写（Android 上 File.write 是异步的，
// 写到一半闪退就没记上）。

const file = () => new File(Paths.document, 'boot-attempts.json');

export const expoAttemptStore: AttemptStore = {
  read() {
    const f = file();
    return f.exists ? f.textSync() : null;
  },
  write(text) {
    file().writeSync(text);
  },
};
