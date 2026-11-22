import type { AttemptStore } from '../rescue/attempts';

/** 测试用的启动计数文件；broken 时读写都抛错（模拟磁盘出问题）。 */
export class MemoryAttemptStore implements AttemptStore {
  text: string | null = null;
  broken = false;
  constructor(initial?: { failures: number; lastError?: string }) {
    if (initial) this.text = JSON.stringify(initial);
  }
  read() {
    if (this.broken) throw new Error('disk');
    return this.text;
  }
  write(text: string) {
    if (this.broken) throw new Error('disk');
    this.text = text;
  }
}
