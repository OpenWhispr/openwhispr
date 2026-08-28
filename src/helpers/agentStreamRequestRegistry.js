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

    const normalizedRequestId = requestId.trim();
    let senderRequests = this.requestsBySender.get(senderId);
    if (!senderRequests) {
      senderRequests = new Map();
      this.requestsBySender.set(senderId, senderRequests);
    }

    senderRequests.get(normalizedRequestId)?.abort();
    const controller = new AbortController();
    senderRequests.set(normalizedRequestId, controller);
    return controller;
  }

  cancel(senderId, requestId) {
    if (!Number.isInteger(senderId) || typeof requestId !== "string") return false;
    const normalizedRequestId = requestId.trim();
    const senderRequests = this.requestsBySender.get(senderId);
    const controller = senderRequests?.get(normalizedRequestId);
    if (!controller) return false;

    controller.abort();
    senderRequests.delete(normalizedRequestId);
    if (senderRequests.size === 0) this.requestsBySender.delete(senderId);
    return true;
  }

  complete(senderId, requestId, controller) {
    if (!Number.isInteger(senderId) || typeof requestId !== "string") return;
    const normalizedRequestId = requestId.trim();
    const senderRequests = this.requestsBySender.get(senderId);
    if (senderRequests?.get(normalizedRequestId) !== controller) return;

    senderRequests.delete(normalizedRequestId);
    if (senderRequests.size === 0) this.requestsBySender.delete(senderId);
  }

  cancelSender(senderId) {
    if (!Number.isInteger(senderId)) return 0;
    const senderRequests = this.requestsBySender.get(senderId);
    if (!senderRequests) return 0;

    for (const controller of senderRequests.values()) controller.abort();
    const cancelledCount = senderRequests.size;
    this.requestsBySender.delete(senderId);
    return cancelledCount;
  }
}

module.exports = AgentStreamRequestRegistry;
