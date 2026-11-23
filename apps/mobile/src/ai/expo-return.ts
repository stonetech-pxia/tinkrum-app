import { File, Paths } from 'expo-file-system';

import type { ReturnStore } from './return';

// 和启动计数一样：Documents 里、数据库外面，同步读写（Android 上 File.write 是异步的）。
const file = () => new File(Paths.document, 'ai-return.json');

export const expoReturnStore: ReturnStore = {
  read() {
    const f = file();
    return f.exists ? f.textSync() : null;
  },
  write(text) {
    file().writeSync(text);
  },
};
