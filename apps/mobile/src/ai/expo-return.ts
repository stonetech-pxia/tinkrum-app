import { File, Paths } from 'expo-file-system';

import type { ReturnStore } from './return';

// Like the startup counter: stored in Documents outside the database, read and written synchronously (File.write is asynchronous on Android).
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
