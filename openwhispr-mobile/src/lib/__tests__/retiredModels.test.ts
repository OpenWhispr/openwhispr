import catalog from '@/config/providerCatalog.json';
import { withoutRetiredModels } from '../retiredModels';
import type { UserConfig } from '@/types';

const nano = {
  mode: 'providers' as const,
  providerId: 'openai',
  modelId: 'gpt-4.1-nano',
  credentialRef: 'provider.openai',
};

it('moves every saved and remembered GPT-4.1 Nano selection to GPT-6 Luna', () => {
  const config: UserConfig = {
    defaultMode: 'providers',
    inference: { cleanup: nano, agent: { ...nano, modelId: 'gpt-6-astra' } },
    rememberedInference: { notes: { providers: nano } },
  };

  expect(withoutRetiredModels(config)).toEqual({
    defaultMode: 'providers',
    inference: {
      cleanup: { ...nano, modelId: 'gpt-6-luna' },
      agent: { ...nano, modelId: 'gpt-6-astra' },
    },
    rememberedInference: { notes: { providers: { ...nano, modelId: 'gpt-6-luna' } } },
  });
});

it('returns the same config when nothing points at a retired model', () => {
  const config: UserConfig = {
    defaultMode: 'providers',
    inference: { cleanup: { ...nano, modelId: 'gpt-5-mini' } },
  };
  expect(withoutRetiredModels(config)).toBe(config);
});

it('leaves the same id under another provider alone', () => {
  const config: UserConfig = {
    defaultMode: 'providers',
    inference: { cleanup: { ...nano, providerId: 'openrouter' } },
  };
  expect(withoutRetiredModels(config)).toBe(config);
});

it('no longer offers the retired model, and offers its replacement', () => {
  const openai = catalog.cloudProviders.find((provider) => provider.id === 'openai');
  const ids = openai?.models.map((model) => model.id) ?? [];
  expect(ids).not.toContain('gpt-4.1-nano');
  expect(ids).toContain('gpt-6-luna');
});
