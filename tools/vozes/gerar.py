"""Records the voices of the characters of Ilha dos Números.

Reads tools/vozes/falas.json (made by exportar.js from the game itself) and writes, for each character, vozes/<name>.mp3 with all of
their lines one after the other, plus vozes/vozes.json saying where each line is.

The voices come from Kokoro (open weights, Apache 2.0, https://github.com/hexgrad/kokoro), which runs here on the computer: nothing is sent
anywhere. Kokoro has three Brazilian voices (pf_dora, pm_alex, pm_santa). To give each character a voice of their own, a Kokoro voice is split in two:
the first half of it shapes the timbre (who is talking) and the second half the rhythm and the melody of the speech. Each character takes the
timbre of a different voice with the rhythm and melody of a Brazilian one, so they all speak Portuguese with a Brazilian lilt and still sound like
different people. Then a pitch and a speed of their own, and for the children a smaller voice (formants moved up), finish the character.

    python tools/vozes/gerar.py                 # records what changed (the rest comes from tools/vozes/.cache)
    python tools/vozes/gerar.py --conferir      # also checks every line with a speech recognizer (Whisper) and lists the doubtful ones

Needs Python 3.10+, ffmpeg with librubberband and libmp3lame, and: pip install -r tools/vozes/requirements.txt
The models (about 350 MB) are downloaded once to tools/vozes/.modelos.
"""
import argparse, hashlib, json, os, re, subprocess, sys, tempfile, unicodedata, urllib.request
import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'vozes')
SR = 24000
KOKORO = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'
WHISPER = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2'

# t = whose timbre, p = whose rhythm and melody (a single name uses that voice whole), s = speed, st = pitch in semitones,
# f = how far the formants move in semitones (a smaller voice when positive; None keeps them where they are)
CAST = {
    # the hosts
    'Rafa':   dict(v='pm_alex', s=1.05, st=0.5),                                # the sea: cheerful, quick
    'Juca':   dict(v={'t': 'am_puck', 'p': 'pm_alex'}, s=1.08, st=2.5),         # the stadium: young and full of energy
    'Theo':   dict(v={'t': 'am_liam', 'p': 'pm_alex'}, s=0.96, st=1.5),         # the farm: calm
    'Seu Zé': dict(v='pm_santa', s=0.90, st=-1.5, f=-0.7),                      # the market: an old, warm voice
    'Bia':    dict(v={'t': 'af_heart', 'p': 'pf_dora'}, s=1.05, st=0.5),        # the village: bright
    'Lia':    dict(v={'t': 'af_aoede', 'p': 'pf_dora'}, s=0.93, st=2.0),        # the park of shapes: soft, dreamy
    'Duda':   dict(v='pf_dora', s=1.00, st=-1.0),                               # the tower: firm
    'Nina':   dict(v={'t': 'ff_siwis', 'p': 'pf_dora'}, s=0.98),                # the workshop: careful
    # the others
    'Mestre': dict(v={'t': 'am_onyx', 'p': 'pm_alex'}, s=0.92, st=-2.0),        # deep and slow: he gives the orders
    'Lojista': dict(v={'t': 'bm_fable', 'p': 'pm_alex'}, s=1.04),               # the shopkeeper: friendly
    # the three friends are children
    'Ana':    dict(v={'t': 'jf_nezumi', 'p': 'pf_dora'}, s=1.05, st=4.0, f=2.5),
    'Pedro':  dict(v={'t': 'af_sky', 'p': 'pf_dora'}, s=1.04, st=2.0, f=1.5),
    'Léo':    dict(v={'t': 'zm_yunxi', 'p': 'pf_dora'}, s=1.00, st=1.5, f=2.0),
}
# words the voices say better spelled another way (the key is the word as written in the game)
SAY = {}
# the way the words become sounds; changing it records everything again
G2P = 'misaki-espeak'


def slug(who):
    return re.sub(r'[^a-z0-9]+', '-', unicodedata.normalize('NFKD', who).encode('ascii', 'ignore').decode().lower()).strip('-')


def fetch(url, dest):
    if os.path.exists(dest): return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f'baixando {url}', flush=True)
    urllib.request.urlretrieve(url, dest + '.part'); os.replace(dest + '.part', dest)
    return dest


class Voice:
    def __init__(self, models):
        from kokoro_onnx import Kokoro
        self.k = Kokoro(fetch(KOKORO + 'kokoro-v1.0.onnx', os.path.join(models, 'kokoro-v1.0.onnx')),
                        fetch(KOKORO + 'voices-v1.0.bin', os.path.join(models, 'voices-v1.0.bin')))
        # The words become sounds the way Kokoro learned them: misaki joins diphthongs and affricates into one symbol each
        # (the "ei" of "bem", the "au" of "legal", the "tch" of "gente"), which kokoro-onnx alone leaves in two pieces.
        # (Kokoro is made first: it points the phonemizer at the espeak-ng that comes with it.)
        from misaki import espeak
        self.g2p = espeak.EspeakG2P(language='pt-br')

    def style(self, v):
        if isinstance(v, str): return self.k.get_voice_style(v)
        s = self.style(v['p']).copy(); s[..., :128] = self.style(v['t'])[..., :128]   # timbre from t, rhythm and melody from p
        return s

    def say(self, text, r):
        a, sr = self.k.create(self.g2p(text), voice=self.style(r['v']), speed=r.get('s', 1.0), lang='pt-br', is_phonemes=True)
        assert sr == SR
        return shift(a.astype(np.float32), r.get('st', 0.0), r.get('f'))


def shift(a, st, f):
    """pitch up or down by st semitones; the formants move by f semitones (stay put when f is None)"""
    if not st and not f: return a
    stages = []
    if f: stages.append(f'rubberband=pitch={2 ** (f / 12):.6f}:formant=shifted:pitchq=quality:transients=mixed')
    rest = st - (f or 0)
    if abs(rest) > 1e-6: stages.append(f'rubberband=pitch={2 ** (rest / 12):.6f}:formant=preserved:pitchq=quality:transients=mixed')
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, 'i.wav'), os.path.join(d, 'o.wav')
        sf.write(i, a, SR, subtype='FLOAT')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', i, '-af', ','.join(stages), o], check=True)
        b, _ = sf.read(o, dtype='float32')
    return b


def tidy(a):
    """cuts the silence around the line (keeping a breath of it), fades the ends and sets every line to the same loudness"""
    fr = int(SR * .01); n = len(a) // fr
    rms = np.sqrt(np.mean(a[:n * fr].reshape(n, fr) ** 2, axis=1) + 1e-12)
    on = np.where(rms > rms.max() * 10 ** (-38 / 20))[0]
    a = a[max(0, on[0] * fr - int(SR * .03)):min(len(a), (on[-1] + 1) * fr + int(SR * .07))].copy()
    voiced = rms[on[0]:on[-1] + 1]; voiced = voiced[voiced > voiced.max() * 10 ** (-30 / 20)]
    g = 10 ** (-19 / 20) / np.sqrt(np.mean(voiced ** 2))          # speech at about -19 dBFS RMS
    g = min(g, 10 ** (-1 / 20) / (np.abs(a).max() + 1e-9))        # and never above -1 dBFS
    a *= g
    k = int(SR * .006); a[:k] *= np.linspace(0, 1, k); a[-k:] *= np.linspace(1, 0, k)
    return np.concatenate([np.zeros(int(SR * .02), np.float32), a.astype(np.float32)])


def mp3(a):
    """one line as a small MP3 of its own: the game cuts the file of a character at these boundaries and unpacks one line at a time"""
    p = subprocess.run(['ffmpeg', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-c:a', 'libmp3lame', '-q:a', '6',
                        '-id3v2_version', '0', '-write_xing', '1', '-f', 'mp3', '-'], input=a.astype('<f4').tobytes(), capture_output=True, check=True)
    return p.stdout


def spoken(text):
    t = text.replace('"', '')
    for w, s in SAY.items(): t = re.sub(rf'\b{re.escape(w)}\b', s, t)
    return t


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--conferir', action='store_true', help='check every line with Whisper and list the doubtful ones')
    ap.add_argument('--modelos', default=os.path.join(HERE, '.modelos'), help='where the models are kept')
    ap.add_argument('--so', help='record only this character')
    o = ap.parse_args()
    falas = json.load(open(os.path.join(HERE, 'falas.json'), encoding='utf-8'))
    missing = set(falas) - set(CAST)
    if missing: sys.exit(f'sem receita de voz para: {", ".join(sorted(missing))} (acrescente em CAST)')
    cache = os.path.join(HERE, '.cache'); os.makedirs(cache, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    man_path = os.path.join(OUT, 'vozes.json')
    manifest = json.load(open(man_path, encoding='utf-8')) if os.path.exists(man_path) else {'chars': {}}
    voice = None; checks = []
    for who, lines in falas.items():
        if o.so and who != o.so: continue
        r = CAST[who]; blob = bytearray(); index = {}
        for ln in lines:
            text = spoken(ln['t'])
            h = hashlib.sha1(json.dumps([G2P, r, text], sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
            wav = os.path.join(cache, h + '.wav')
            if not os.path.exists(wav):
                voice = voice or Voice(o.modelos)
                sf.write(wav, tidy(voice.say(text, r)), SR, subtype='FLOAT')
            a, _ = sf.read(wav, dtype='float32')
            b = mp3(a); index[ln['k']] = [len(blob), len(b), round(len(a) / SR, 2)]; blob += b
            checks.append((who, ln['t'], wav))
        f = slug(who) + '.mp3'
        open(os.path.join(OUT, f), 'wb').write(blob)
        manifest['chars'][who] = {'f': f, 'l': index}
        print(f'{who:8s} {len(lines):4d} falas  {sum(x[2] for x in index.values()):6.1f} s  {len(blob) / 1024:7.1f} KB', flush=True)
    manifest['chars'] = {w: manifest['chars'][w] for w in falas if w in manifest['chars']}
    json.dump(manifest, open(man_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'pronto: {os.path.relpath(OUT, ROOT)}/ (lembre de aumentar o CACHE em sw.js)')
    if o.conferir: conferir(checks, o.modelos, voice or Voice(o.modelos))


def conferir(checks, models, voice):
    """Whisper writes down what it hears; a line it hears quite differently from the text is worth listening to.
    A short line alone ("Arrasou!") is hard to make out without context, also for a person, so every line is heard
    inside a sentence said by the same voice: "Então ele disse: <line> E foi embora." """
    import difflib, tarfile, sherpa_onnx
    d = os.path.join(models, 'sherpa-onnx-whisper-small')
    if not os.path.isdir(d):
        tb = fetch(WHISPER, os.path.join(models, 'whisper-small.tar.bz2'))
        with tarfile.open(tb) as t: t.extractall(models)
    asr = sherpa_onnx.OfflineRecognizer.from_whisper(encoder=os.path.join(d, 'small-encoder.int8.onnx'), decoder=os.path.join(d, 'small-decoder.int8.onnx'),
                                                     tokens=os.path.join(d, 'small-tokens.txt'), language='pt', task='transcribe', num_threads=4)
    nums = {'0': 'zero', '1': 'um', '2': 'dois', '3': 'três', '4': 'quatro', '5': 'cinco', '6': 'seis', '7': 'sete', '8': 'oito', '9': 'nove', '10': 'dez'}
    words = lambda t: [nums.get(w, w) for w in re.findall(r'[\wáéíóúâêôãõàçü]+', t.lower().replace('-', ' '))]
    pre, post = 'Então ele disse:', 'E foi embora.'
    gap = np.zeros(int(SR * .12), np.float32); carriers = {}; bad = []
    for who, text, wav in checks:
        if who not in carriers: carriers[who] = (tidy(voice.say(pre, CAST[who])), tidy(voice.say(post, CAST[who])))
        a, _ = sf.read(wav, dtype='float32'); p, q = carriers[who]
        s = asr.create_stream()
        if s.has_option('max_tokens_per_second'): s.set_option('max_tokens_per_second', '30')
        s.accept_waveform(SR, np.concatenate([p, gap, a, gap, q])); asr.decode_stream(s); heard = s.result.text.strip()
        hw = words(heard)
        # take the carrier off both ends of what was heard (it is told apart by its words, wherever the line starts)
        fit = lambda ws, c: difflib.SequenceMatcher(None, ' '.join(ws), c).ratio()
        n = max(range(0, min(4, len(hw)) + 1), key=lambda n: (fit(hw[:n], 'então ele disse'), -n)); hw = hw[n:]
        n = max(range(0, min(4, len(hw)) + 1), key=lambda n: (fit(hw[len(hw) - n:], 'e foi embora'), -n)); hw = hw[:len(hw) - n]
        score = difflib.SequenceMatcher(None, ' '.join(words(text)), ' '.join(hw)).ratio()
        if score < .8: bad.append((score, who, text, ' '.join(hw)))
    print(f'\nconferidas {len(checks)} falas; {len(bad)} para ouvir:')
    for score, who, text, heard in sorted(bad):
        print(f'  {score:.2f} {who}: "{text}"  ouvido: "{heard}"')


if __name__ == '__main__':
    main()
