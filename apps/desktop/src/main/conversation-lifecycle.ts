/** Main-process async lifetime fence, not an execution/safety authorization source. */
export class ConversationLifecycle {
  private readonly using = new Map<string, number>();
  private readonly deleting = new Set<string>();

  assertAvailable(id: string): void {
    if (this.deleting.has(id)) throw new Error('对话正在删除，请等待清理完成');
  }

  async use<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    this.assertAvailable(id);
    this.using.set(id, (this.using.get(id) ?? 0) + 1);
    try { return await action(); }
    finally {
      const count = this.using.get(id)! - 1;
      if (count) this.using.set(id, count); else this.using.delete(id);
    }
  }

  async delete<T>(id: string, action: () => T | Promise<T>): Promise<T> {
    this.assertAvailable(id);
    if (this.using.has(id)) throw new Error('对话请求仍在处理中，请稍后再删除');
    this.deleting.add(id);
    try { return await action(); }
    finally { this.deleting.delete(id); }
  }
}
