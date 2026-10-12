import { LocalSpacesRepository } from './local/spacesRepository';
import type { SpacesRepository } from './spacesTypes';

let defaultSpacesRepository: SpacesRepository | null = null;

export function getSpacesRepository(): SpacesRepository {
  defaultSpacesRepository ??= new LocalSpacesRepository();
  return defaultSpacesRepository;
}

export const spacesRepository: SpacesRepository = new Proxy({} as SpacesRepository, {
  get(_target, property) {
    const repo = getSpacesRepository();
    const value = Reflect.get(repo, property);
    return typeof value === 'function' ? value.bind(repo) : value;
  },
});
