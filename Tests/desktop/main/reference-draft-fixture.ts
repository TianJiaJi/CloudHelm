import { EventEmitter } from 'node:events';

let route = 0;
export class DraftSender extends EventEmitter {
  destroyed = false;
  loading = false;
  mainFrame = { processId: 1, routingId: ++route, isDestroyed: () => false };
  isDestroyed() { return this.destroyed; }
  isLoadingMainFrame() { return this.loading; }
  event() { return { sender: this, senderFrame: this.mainFrame }; }
  navigate() {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    this.mainFrame = { processId: 1, routingId: ++route, isDestroyed: () => false };
  }
}
