import React, { useState, useEffect } from "react";

export const LoadingDots = () => {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 350);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "flex-end", height: 10, gap: 1 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="bg-text-on-solid"
          style={{
            width: 4,
            height: 6 + 6 * (tick % 3 === i ? 1 : 0),
            borderRadius: "var(--radius-sm)",
            opacity: "var(--opacity-high)",
            transition: "height 0.2s",
          }}
        />
      ))}
    </div>
  );
};
