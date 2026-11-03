// English MIT checkpoints on OpenWhispr-owned storage; see docs/android/moonshine-runtime-research.md.
export const MOONSHINE_MODELS = {
  'moonshine-tiny': {
    title: 'Moonshine Tiny Streaming',
    kind: 'speech',
    bytes: 45233659,
    files: [
      {
        name: 'adapter.ort',
        bytes: 1319664,
        sha256: '22ecc949e146c49667fda28d102d4e30749a107dc88a396292aa8f277ef1347c',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/tiny-streaming-en/quantized_26_08_21/adapter.ort',
      },
      {
        name: 'cross_kv.ort',
        bytes: 1287544,
        sha256: '143a36667b8d05fd9d04e8c337b7ee121f37ef299aea6b3d82bdb3d3401950b4',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/tiny-streaming-en/quantized_26_08_21/cross_kv.ort',
      },
      {
        name: 'decoder_kv.ort',
        bytes: 32583720,
        sha256: '8852553f312adb6c9aa4d17418015049b30f412209ee569d336548c0044627de',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/tiny-streaming-en/quantized_26_08_21/decoder_kv.ort',
      },
      {
        name: 'encoder.ort',
        bytes: 7675440,
        sha256: 'a8414e1a5dedf9f2093d7680601dd8a9b0433e7020260eafe0e370ead91134ca',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/tiny-streaming-en/quantized_26_08_21/encoder.ort',
      },
      {
        name: 'frontend.model.ort',
        bytes: 23344,
        sha256: '5121b561417b638afce0c6c31b760e37c93cf97f80d9b0031aad1fe7b6f25d61',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/tiny-streaming-en/quantized_26_08_21/frontend.model.ort',
      },
      {
        name: 'frontend.weights.ort',
        bytes: 2093464,
        sha256: '217da24ac6f522ebf02da8ef288e77d1ac68d50d4a6821433182e4fbf4204bbd',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/tiny-streaming-en/quantized_26_08_21/frontend.weights.ort',
      },
      {
        name: 'streaming_config.json',
        bytes: 509,
        sha256: '74fe5ddebd63b17caf59e8a3b18c17547ff7bce1642050edbb1c3962674f8950',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/tiny-streaming-en/quantized_26_08_21/streaming_config.json',
      },
      {
        name: 'tokenizer.bin',
        bytes: 249974,
        sha256: '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/tiny-streaming-en/quantized_26_08_21/tokenizer.bin',
      },
    ],
  },
  'moonshine-small': {
    title: 'Moonshine Small Streaming',
    kind: 'speech',
    bytes: 142300974,
    files: [
      {
        name: 'adapter.ort',
        bytes: 2870368,
        sha256: 'c665f742364febad597cc9ac1e0b341ffbee0e24a1466e2f3bde95e6e4771762',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/small-streaming-en/quantized_26_08_21/adapter.ort',
      },
      {
        name: 'cross_kv.ort',
        bytes: 5356536,
        sha256: 'e2d3417144e9514055ebfefe8dcc4c0a55a55adcb8530435844c75c53e352bf6',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/small-streaming-en/quantized_26_08_21/cross_kv.ort',
      },
      {
        name: 'decoder_kv.ort',
        bytes: 81878600,
        sha256: '1a05465b1dd955858dfcbee039c0020fb5dd982b0f5094c34e61735d518d771b',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/small-streaming-en/quantized_26_08_21/decoder_kv.ort',
      },
      {
        name: 'encoder.ort',
        bytes: 44148576,
        sha256: '2d4d973e91e8aca08c51e7e7efa28a46ab265b63d809d5294d18b86bcd85b993',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/small-streaming-en/quantized_26_08_21/encoder.ort',
      },
      {
        name: 'frontend.model.ort',
        bytes: 26944,
        sha256: '09b1210ae30dc5f0f3e45f0ebab914c254741323114f53fbbe5ae62cca35058f',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/small-streaming-en/quantized_26_08_21/frontend.model.ort',
      },
      {
        name: 'frontend.weights.ort',
        bytes: 7769464,
        sha256: '7ef97521bd4bad3928f5bb6808586f4fcc6e92bd5990394112eed7d4052ec338',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/small-streaming-en/quantized_26_08_21/frontend.weights.ort',
      },
      {
        name: 'streaming_config.json',
        bytes: 512,
        sha256: '26f02b6afb22d60871a5efd85c3d38e569cc0ddb6c5eb6e93d3260152ae8a47a',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/small-streaming-en/quantized_26_08_21/streaming_config.json',
      },
      {
        name: 'tokenizer.bin',
        bytes: 249974,
        sha256: '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d',
        url: 'https://ykb51mbn67loueo2.public.blob.vercel-storage.com/models/moonshine/0bf2f2e5aff22e6fbba4300b00a4e00bbc4f8aae/small-streaming-en/quantized_26_08_21/tokenizer.bin',
      },
    ],
  },
} as const;
