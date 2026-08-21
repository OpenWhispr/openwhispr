import openvino_genai as ov_genai, json, struct, time, os, numpy as np, glob

dump_dir = os.path.expandvars(r'%APPDATA%\open-whispr\models\logs\f32_dumps')
model_path = os.path.expandvars(r'%APPDATA%\open-whispr\models\npu-whisper\whisper-large-v3-turbo-fp16-ov-npu')
cache_dir = os.path.expandvars(r'%APPDATA%\open-whispr\models\npu-whisper\npu_cache')

dumps = sorted(glob.glob(os.path.join(dump_dir, '*.f32')))
for df in dumps:
    name = os.path.basename(df)
    jf = df.replace('.f32', '.json')
    
    with open(df, 'rb') as f:
        raw = f.read()
    n = len(raw) // 4
    audio = list(struct.unpack(f'{n}f', raw))
    
    with open(jf) as f:
        cfg = json.load(f)
    
    dur = len(audio) / 16000
    rms_val = float(np.sqrt(np.mean(np.array(audio)**2)))
    print(f'--- {name[:55]} ---')
    print(f'  samples={len(audio)} dur={dur:.1f}s rms={rms_val:.6f}')
    print(f'  max_tokens={cfg["max_tokens"]} gen_args={cfg["gen_args"]}')
    print(f'  min={np.min(audio):.4f} max={np.max(audio):.4f}')
    
    pipe = ov_genai.WhisperPipeline(model_path, 'NPU', **{'CACHE_DIR': cache_dir})
    kw = cfg['gen_args']
    try:
        t0 = time.time()
        r = pipe.generate(audio, max_new_tokens=cfg['max_tokens'], **kw)
        elapsed = time.time() - t0
        text = str(r) if r else ''
        print(f'  RESULT: {elapsed:.1f}s -> "{text[:100]}"')
    except RuntimeError as e:
        print(f'  RESULT: FAILED - {str(e)[:150]}')
    print()
