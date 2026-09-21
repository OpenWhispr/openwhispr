import { LocalCalendarRepository } from './local/calendarRepository';
import type { CalendarRepository } from './calendarTypes';

let defaultCalendarRepository: CalendarRepository | null = null;

export function getCalendarRepository(): CalendarRepository {
  defaultCalendarRepository ??= new LocalCalendarRepository();
  return defaultCalendarRepository;
}

export const calendarRepository: CalendarRepository = new Proxy({} as CalendarRepository, {
  get(_target, property) {
    const repo = getCalendarRepository();
    const value = Reflect.get(repo, property);
    return typeof value === 'function' ? value.bind(repo) : value;
  },
});
