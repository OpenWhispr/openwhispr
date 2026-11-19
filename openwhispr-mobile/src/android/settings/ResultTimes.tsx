import { useEffect, useState } from 'react';
import { Easing } from 'react-native';
import { Group, ListRow, useReduceMotion } from './kit';
import { useSettingsT, type SettingsKey } from './strings';

const COUNT_MS = 400;
const STAGGER_MS = 60;

/** Check this phone's times, counting up from zero one row after another; Total lands last. */
export function ResultTimes({
  times,
}: {
  times: Record<'recording' | 'speech' | 'cleanup' | 'total', number>;
}) {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const [elapsed, setElapsed] = useState(reduceMotion ? Infinity : 0);
  const rows = Object.entries(times) as [SettingsKey, number][];
  useEffect(() => {
    if (reduceMotion) {
      setElapsed(Infinity);
      return;
    }
    const start = Date.now();
    const end = COUNT_MS + STAGGER_MS * (rows.length - 1);
    let frame = requestAnimationFrame(function tick() {
      const now = Date.now() - start;
      setElapsed(now);
      if (now < end) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [times, reduceMotion, rows.length]);
  return (
    <Group title={t('yourResult')} inset={14}>
      {rows.map(([key, ms], index) => {
        const progress = Math.min(1, Math.max(0, (elapsed - index * STAGGER_MS) / COUNT_MS));
        const shown = (ms / 1000) * Easing.out(Easing.cubic)(progress);
        return (
          <ListRow
            key={key}
            title={t(key)}
            value={t('seconds', { value: shown.toFixed(1) })}
            valueAccent={progress > 0 && progress < 1}
            trailing={null}
            accessibilityLabel={`${t(key)} ${t('seconds', { value: (ms / 1000).toFixed(1) })}`}
          />
        );
      })}
    </Group>
  );
}
