export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

interface ScrollFollowOptions {
  nearBottomThreshold: number;
  rejoinThreshold?: number;
}

export interface ScrollFollowController {
  isFollowing: () => boolean;
  leaveBottom: () => void;
  update: (metrics: ScrollMetrics) => boolean;
  follow: () => void;
}

export function getScrollBottomDistance(metrics: ScrollMetrics): number {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
}

export function createScrollFollowController({
  nearBottomThreshold,
  rejoinThreshold = 1,
}: ScrollFollowOptions): ScrollFollowController {
  let following = true;
  let readerLeftBottom = false;
  let readerMovedAway = false;

  return {
    isFollowing: () => following,
    leaveBottom: () => {
      readerLeftBottom = true;
      readerMovedAway = false;
      following = false;
    },
    update: (metrics) => {
      const distanceToBottom = getScrollBottomDistance(metrics);
      if (readerLeftBottom) {
        if (distanceToBottom > rejoinThreshold) {
          readerMovedAway = true;
        } else if (readerMovedAway) {
          readerLeftBottom = false;
          readerMovedAway = false;
          following = true;
        }
        return following;
      }

      following = distanceToBottom <= nearBottomThreshold;
      return following;
    },
    follow: () => {
      readerLeftBottom = false;
      readerMovedAway = false;
      following = true;
    },
  };
}
