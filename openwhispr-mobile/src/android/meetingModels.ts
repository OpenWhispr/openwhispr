/** Public upstream conversions, pinned by SHA256 and checked before use. */
export const MEETING_MODELS = {
  'meeting-speakers': {
    title: 'Meeting speakers',
    kind: 'diarization',
    bytes: 41797789,
    files: [
      {
        name: 'segmentation.int8.onnx',
        bytes: 1540506,
        sha256: 'd582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d',
        url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a6902bb58e3d5ae8c7e77c3422de279db2e0/model.int8.onnx',
      },
      {
        name: 'nemo_en_titanet_small.onnx',
        bytes: 40257283,
        sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e',
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
      },
    ],
  },
} as const;
