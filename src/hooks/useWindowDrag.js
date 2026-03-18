import { useState, useEffect } from "react";

export const useWindowDrag = () => {
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = (e) => {
    if (e.button === 0) {
      // Left mouse button
      setIsDragging(true);
      window.electronAPI?.startWindowDrag?.();
      e.preventDefault();
    }
  };

  const handleMouseUp = () => {
    if (isDragging) {
      setIsDragging(false);
      window.electronAPI?.stopWindowDrag?.();
    }
  };

  const handleClick = (e) => {
    // Prevent any click actions - use hotkey only
    e.preventDefault();
  };

  // Set up global mouse up listener when dragging
  useEffect(() => {
    if (isDragging) {
      const handleGlobalMouseUp = () => {
        setIsDragging(false);
        window.electronAPI?.stopWindowDrag?.();
      };

      document.addEventListener("mouseup", handleGlobalMouseUp);

      return () => {
        document.removeEventListener("mouseup", handleGlobalMouseUp);
      };
    }
  }, [isDragging]);

  return {
    isDragging,
    handleMouseDown,
    handleMouseUp,
    handleClick,
  };
};
