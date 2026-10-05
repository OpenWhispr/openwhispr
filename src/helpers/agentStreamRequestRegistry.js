class AgentStreamRequestRegistry {
  constructor() {
    this.requestsBySender = new Map();
  }

  begin(senderId, requestId) {
    if (!Number.isInteger(senderId)) {
      throw new TypeError("senderId must be an integer");
    }
    if (typeof requestId !== "string" || !requestId.trim()) {
      throw new TypeError("requestId must be a non-empty string");
    }

    let senderRequests = this.requestsBySender.get(senderId);
    if (!senderRequests) {
      senderRequests = new Map();
      this.requestsBySender.set(senderId, senderRequests);
    }

    senderRequests.get(requestId)?.abort();
    const controller = new AbortController();
    senderRequests.set(requestId, controller);
    return controller;
  }

  cancel(senderId, requestId) {
    const senderRequests = this.requestsBySender.get(senderId);
    const controller = senderRequests?.get(requestId);
    if (!controller) return false;

    controller.abort();
    senderRequests.delete(requestId);
    if (senderRequests.size === 0) this.requestsBySender.delete(senderId);
    return true;
  }

  complete(senderId, requestId, controller) {
    const senderRequests = this.requestsBySender.get(senderId);
    if (senderRequests?.get(requestId) !== controller) return;

    senderRequests.delete(requestId);
    if (senderRequests.size === 0) this.requestsBySender.delete(senderId);
  }

  cancelSender(senderId) {
    const senderRequests = this.requestsBySender.get(senderId);
    if (!senderRequests) return 0;

    for (const controller of senderRequests.values()) controller.abort();
    const cancelledCount = senderRequests.size;
    this.requestsBySender.delete(senderId);
    return cancelledCount;
  }
}

module.exports = AgentStreamRequestRegistry;
