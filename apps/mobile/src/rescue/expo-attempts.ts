import { File, Paths } from 'expo-file-system';

import type { AttemptStore } from './attempts';

// Boot attempt counter file resides in Documents, outside the database. Uses synchronous read/write
// (File.write is asynchronous on Android; a crash midway would leave it unrecorded).

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
