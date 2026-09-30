// Small Standard MIDI File codec: PPQ format 0/1, tempo, programs and notes.
// No device MIDI access, SoundFont download or dependency required.
export function decodeMidi(source) {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  let pos = 0, limit = bytes.length;
  const byte = () => { if (pos >= limit) throw new Error("MIDI tronqué"); return bytes[pos++]; };
  const int = n => { let value = 0; while (n--) value = value * 256 + byte(); return value; };
  const tag = () => String.fromCharCode(byte(), byte(), byte(), byte());
  const variable = () => {
    let value = 0;
    for (let i = 0; i < 4; i++) { const b = byte(); value = value * 128 + (b & 127); if (!(b & 128)) return value; }
    throw new Error("Delta MIDI invalide");
  };
  const skip = size => { if (pos + size > limit) throw new Error("MIDI tronqué"); pos += size; };
  if (tag() !== "MThd") throw new Error("Fichier MIDI attendu");
  const headerLength = int(4), format = int(2), tracks = int(2), ppq = int(2);
  if (headerLength < 6 || format > 1 || !tracks || !ppq || ppq & 0x8000) throw new Error("MIDI format 0/1 avec timing PPQ requis");
  skip(headerLength - 6);
  const events = [];
  let endTick = 0;
  for (let track = 0; track < tracks; track++) {
    limit = bytes.length;
    if (tag() !== "MTrk") throw new Error("Piste MIDI absente");
    const length = int(4), end = pos + length;
    if (end > bytes.length) throw new Error("MIDI tronqué");
    limit = end;
    let tick = 0, running = 0;
    while (pos < end) {
      tick += variable();
      let status = byte();
      if (status < 128) { pos--; status = running; if (!status) throw new Error("Statut MIDI absent"); }
      else if (status < 240) running = status;
      else running = 0;
      if (status === 255) {
        const type = byte(), size = variable();
        if (type === 81 && size === 3) {
          const tempo = int(3);
          if (!tempo) throw new Error("Tempo MIDI invalide");
          events.push({ tick, tempo });
        } else skip(size);
        if (type === 47) { pos = end; break; }
      } else if (status === 240 || status === 247) skip(variable());
      else {
        const kind = status >> 4, channel = status & 15;
        if (kind < 8 || kind > 14) throw new Error("Événement MIDI non supporté");
        const a = byte(), b = kind === 12 || kind === 13 ? 0 : byte();
        if (a > 127 || b > 127) throw new Error("Donnée MIDI invalide");
        events.push({ tick, kind, channel, a, b });
      }
    }
    endTick = Math.max(endTick, tick);
  }
  events.sort((a, b) => a.tick - b.tick);
  const programs = Array(16).fill(0), volumes = Array(16).fill(1), held = new Map(), notes = [];
  let tick = 0, time = 0, tempo = 500000;
  for (const event of events) {
    time += (event.tick - tick) / ppq * tempo / 1e6;
    tick = event.tick;
    if (event.tempo) { tempo = event.tempo; continue; }
    const { kind, channel, a, b } = event, key = channel * 128 + a;
    if (kind === 12) programs[channel] = a;
    if (kind === 11 && a === 7) volumes[channel] = b / 127;
    if (kind === 9 && b) {
      const note = { time, duration: 0, pitch: a, velocity: b / 127 * volumes[channel], program: programs[channel], channel };
      const queue = held.get(key) ?? [];
      queue.push(note); held.set(key, queue); notes.push(note);
    } else if (kind === 8 || kind === 9) {
      const note = held.get(key)?.shift();
      if (note) note.duration = Math.max(0.01, time - note.time);
    }
  }
  const duration = time + (endTick - tick) / ppq * tempo / 1e6;
  for (const note of notes) if (!note.duration) note.duration = Math.max(.01, duration - note.time);
  if (!notes.length || duration <= 0 || duration > 600) throw new Error("Boucle MIDI vide ou trop longue (10 min maximum)");
  return { notes, duration };
}

// Authoring helper also copied into the cartridge workspace as reference/midi.mjs.
// Beats and note durations are quarter notes; pitches and programs are MIDI numbers.
export function encodeMidi({ bpm = 100, beats, tracks }) {
  if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300 || !Number.isFinite(beats) || beats <= 0) throw new Error("Tempo/durée invalide");
  const ppq = 480, events = [], end = Math.round(beats * ppq);
  const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  const u16 = n => [n >> 8 & 255, n & 255];
  const u32 = n => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255];
  const variable = n => { const data = [n & 127]; while ((n = Math.floor(n / 128))) data.unshift((n & 127) | 128); return data; };
  const tempo = Math.round(60000000 / bpm);
  events.push({ tick: 0, order: 0, data: [255, 81, 3, tempo >> 16, tempo >> 8 & 255, tempo & 255] });
  for (const { channel = 0, program = 0, notes } of tracks) {
    if (!integer(channel, 0, 15) || !integer(program, 0, 127)) throw new Error("Canal/instrument invalide");
    events.push({ tick: 0, order: 0, data: [192 | channel, program] });
    for (const [beat, pitch, duration, velocity = 80] of notes) {
      if (!Number.isFinite(beat) || beat < 0 || !Number.isFinite(duration) || duration <= 0 || beat + duration > beats + 1e-6 || !integer(pitch, 0, 127) || !integer(velocity, 1, 127)) throw new Error("Note MIDI invalide");
      events.push({ tick: Math.round(beat * ppq), order: 2, data: [144 | channel, pitch, velocity] });
      events.push({ tick: Math.round((beat + duration) * ppq), order: 1, data: [128 | channel, pitch, 0] });
    }
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);
  let previous = 0;
  const data = [];
  for (const event of events) { data.push(...variable(event.tick - previous), ...event.data); previous = event.tick; }
  data.push(...variable(end - previous), 255, 47, 0);
  return new Uint8Array([77, 84, 104, 100, ...u32(6), ...u16(0), ...u16(1), ...u16(ppq), 77, 84, 114, 107, ...u32(data.length), ...data]);
}
