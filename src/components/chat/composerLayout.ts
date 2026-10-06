const COMPOSER_GAP_PX = 8;

interface ResizeObserverHandle {
  observe: (element: Element) => void;
  disconnect: () => void;
}

export function observeChatComposerInset(
  composer: HTMLElement,
  container: HTMLElement,
  createObserver: (callback: () => void) => ResizeObserverHandle = (callback) =>
    new ResizeObserver(callback)
): () => void {
  const updateInset = () => {
    container.style.setProperty(
      "--chat-composer-inset",
      `${composer.offsetHeight + COMPOSER_GAP_PX}px`
    );
  };

  updateInset();
  const observer = createObserver(updateInset);
  observer.observe(composer);

  return () => {
    observer.disconnect();
    container.style.removeProperty("--chat-composer-inset");
  };
}
